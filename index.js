#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// =========================================================================
// 🔧 CONFIGURAÇÕES
// =========================================================================

// Lê dinamicamente o wrangler.toml para descobrir o nome do banco D1 e bucket R2
let DB_NAME = "";
let R2_BUCKET = "";
try {
  const wranglerToml = fs.readFileSync(path.join(__dirname, 'wrangler.toml'), 'utf-8');
  const dbMatch = wranglerToml.match(/database_name\s*=\s*"([^"]+)"/);
  const r2Match = wranglerToml.match(/bucket_name\s*=\s*"([^"]+)"/);
  
  if (!dbMatch || !r2Match) {
    throw new Error("Não foi possível encontrar database_name ou bucket_name no wrangler.toml");
  }
  DB_NAME = dbMatch[1];
  R2_BUCKET = r2Match[1];
} catch (err) {
  console.error(`❌ Erro ao ler wrangler.toml: ${err.message}`);
  process.exit(1);
}
// =========================================================================

// Helper para tentar matar o servidor dev que possa estar bloqueando os arquivos
function killDevServer(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== "0") {
            console.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          }
        }
      }
    } else {
      const output = execSync(`lsof -t -i:${port}`).toString().trim();
      const pids = output.split('\n').filter(Boolean);
      for (const pid of pids) {
        console.log(`🔫 Matando processo do dev server (PID: ${pid}) na porta ${port}...`);
        execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
      }
    }
    // Aguarda um segundo para o SO liberar os locks dos arquivos
    execSync(process.platform === 'win32' ? 'timeout /t 1 /nobreak' : 'sleep 1', { stdio: 'ignore' });
  } catch (err) {
    // Falha silenciosa (porta livre)
  }
}

killDevServer(4321);

console.log('🧹 Limpando banco e storage locais antigos...');
const d1Dir = path.join('.wrangler', 'state', 'v3', 'd1');
const r2Dir = path.join('.wrangler', 'state', 'v3', 'r2');

try {
  if (fs.existsSync(d1Dir)) fs.rmSync(d1Dir, { recursive: true, force: true });
  if (fs.existsSync(r2Dir)) fs.rmSync(r2Dir, { recursive: true, force: true });
} catch (err) {
  console.error('❌ Não foi possível apagar os arquivos antigos. O servidor dev ainda pode estar rodando ou prendendo o arquivo.');
  process.exit(1);
}

console.log(`🚀 Exportando as tabelas do D1 de produção [Banco: ${DB_NAME}]...`);
const tables = [
  '_emdash_migrations', 'revisions', 'media', 'options', 'audit_logs', 
  '_emdash_collections', '_emdash_fields', '_plugin_storage', '_plugin_state', 
  '_plugin_indexes', '_emdash_widget_areas', '_emdash_widgets', 'users', 
  'credentials', 'auth_tokens', 'oauth_accounts', 'allowed_domains', 
  'auth_challenges', '_emdash_sections', '_emdash_api_tokens', '_emdash_oauth_tokens', 
  '_emdash_device_codes', '_emdash_authorization_codes', '_emdash_seo', 
  '_emdash_oauth_clients', '_emdash_cron_tasks', '_emdash_comments', 
  '_emdash_redirects', '_emdash_404_log', '_emdash_bylines', '_emdash_content_bylines', 
  '_emdash_rate_limits', 'ec_posts', 'ec_pages', 'ec_portfolio', 'ec_services', 
  'content_taxonomies', '_emdash_menu_items', '_emdash_menus', 'taxonomies', 
  '_emdash_taxonomy_defs'
];

const args = tables.map(t => '--table=' + t).join(' ');

async function sync() {
  try {
    execSync(`npx wrangler d1 export ${DB_NAME} --remote ${args} --output=tabela.sql`, { stdio: 'inherit' });

    console.log('\n📥 Importando o banco para o ambiente local...');
    execSync(`npx wrangler d1 execute ${DB_NAME} --local --file=tabela.sql`, { stdio: 'inherit' });

    console.log('✅ Banco de dados sincronizado com sucesso!');
    console.log('🖼️  Buscando informações do site e lista de imagens...');

    // Busca a URL de produção na tabela options
    const urlResultStr = execSync(`npx wrangler d1 execute ${DB_NAME} --local --command "SELECT value FROM options WHERE name = 'emdash:site_url'" --json`, { encoding: 'utf-8' });
    const urlData = JSON.parse(urlResultStr);
    let PROD_URL = "";
    if (urlData[0].results && urlData[0].results.length > 0) {
      // O valor vem serializado (ex: '"https://..."')
      PROD_URL = JSON.parse(urlData[0].results[0].value);
      console.log(`🌐 URL do projeto detectada: ${PROD_URL}`);
    } else {
      throw new Error("Não foi possível determinar a URL do projeto (emdash:site_url ausente na tabela options). Verifique se o banco remoto possui a URL configurada.");
    }

    // Busca os registros no banco D1 local
    const resultStr = execSync(`npx wrangler d1 execute ${DB_NAME} --local --command "SELECT id, mime_type, storage_key FROM media" --json`, { encoding: 'utf-8' });
    const dbData = JSON.parse(resultStr);
    const mediaFiles = dbData[0].results;

    if (mediaFiles && mediaFiles.length > 0) {
      console.log(`Encontradas ${mediaFiles.length} imagens no banco. Sincronizando com R2 local em lotes [Bucket: ${R2_BUCKET}]...`);
      
      const tmpSyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-'));
      
      try {
        const fetchWithRetry = async (url, retries = 1) => {
          for (let i = 0; i <= retries; i++) {
            try {
              const res = await fetch(url);
              if (res.ok || i === retries) return res;
            } catch (err) {
              if (i === retries) throw err;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        };

        const processFile = async (file) => {
          const storageKey = file.storage_key || file.id;
          const url = `${PROD_URL}/_emdash/api/media/file/${storageKey}`;
          const tempPath = path.join(tmpSyncDir, storageKey);
          
          try {
            const response = await fetchWithRetry(url, 1);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              // Gravação síncrona garante que o stream de gravação está fechado antes de chamar o wrangler
              fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
              
              execSync(`npx wrangler r2 object put ${R2_BUCKET}/${storageKey} --file "${tempPath}" --local --content-type "${file.mime_type}"`, { stdio: ['ignore', 'ignore', 'ignore'] });
              console.log(`- ✅ Baixado e salvo: ${storageKey}`);
            } else {
              console.warn(`- ⚠️ [Ignorado] Falha ao baixar ${storageKey} (Status: ${response.status}) - Pode ter sido deletado em produção.`);
            }
          } catch (fetchErr) {
             console.error(`- ❌ Erro ao processar ${storageKey}:`, fetchErr.message);
          } finally {
            if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
          }
        };

        // Processa as imagens em lotes de 10
        const batchSize = 10;
        for (let i = 0; i < mediaFiles.length; i += batchSize) {
          const batch = mediaFiles.slice(i, i + batchSize);
          await Promise.all(batch.map(processFile));
        }
      } finally {
        if (fs.existsSync(tmpSyncDir)) {
          fs.rmSync(tmpSyncDir, { recursive: true, force: true });
        }
      }
    }

    console.log('\n🎉 Sincronização 100% concluída! Ambiente local idêntico à produção.');

  } catch (error) {
    console.error('\n❌ Erro durante a sincronização:', error.message);
  } finally {
    // 3. Sanitização de Segurança: Deletar tabela.sql gerado pelo export
    const sqlFile = path.join(__dirname, 'tabela.sql');
    if (fs.existsSync(sqlFile)) {
      fs.rmSync(sqlFile, { force: true });
      console.log('\n🧹 [Sanitização] Arquivo temporário de dump SQL deletado com sucesso.');
    }
  }
}

sync();
