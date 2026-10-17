'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ui = require('./ui');
const { d1Query, r2PutObject } = require('./wrangler');

/** Baixa uma URL com 1 retry e 1s de espera entre tentativas. */
async function fetchWithRetry(url, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || i === retries) return res;
    } catch (err) {
      if (i === retries) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Espelha as mídias de produção no R2 local: lista a tabela `media`, baixa
 * cada arquivo pela API pública e injeta no emulador em lotes de 10.
 * Imprime o relatório final (banco × baixadas/ignoradas/falhas).
 */
async function syncMedia({ dbName, r2Bucket, prodUrl }) {
  const mediaFiles = d1Query(dbName, 'SELECT id, mime_type, storage_key FROM media');
  const stats = { downloaded: 0, skipped: 0, failed: 0 };

  if (mediaFiles.length > 0) {
    ui.log(`Encontradas ${mediaFiles.length} mídias no banco. Sincronizando com R2 local em lotes [Bucket: ${r2Bucket}]...`);

    const tmpSyncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-sync-'));

    const processFile = async (file) => {
      const storageKey = file.storage_key || file.id;

      if (!storageKey) {
        stats.skipped += 1;
        ui.warn('- ⚠️ [Ignorado] Registro de mídia sem storage_key.');
        return;
      }

      const url = `${prodUrl}/_emdash/api/media/file/${storageKey}`;
      const tempPath = path.join(tmpSyncDir, storageKey);

      try {
        const response = await fetchWithRetry(url, 1);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          // Gravação síncrona garante que o stream de gravação está fechado antes de chamar o wrangler
          fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));

          r2PutObject(r2Bucket, storageKey, tempPath, file.mime_type);
          stats.downloaded += 1;
          ui.log(`- ✅ Baixado e salvo: ${storageKey}`);
        } else {
          stats.skipped += 1;
          ui.warn(`- ⚠️ [Ignorado] Falha ao baixar ${storageKey} (Status: ${response.status}) - Pode ter sido deletado em produção.`);
        }
      } catch (fetchErr) {
        stats.failed += 1;
        ui.fail(`- ❌ Erro ao processar ${storageKey}: ${fetchErr.message}`);
      } finally {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
      }
    };

    try {
      // Processa as mídias em lotes de 10
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

  // Relatório: compara as mídias do banco com o que foi gravado no R2 local.
  const mediaCount = Number((d1Query(dbName, 'SELECT count(*) AS n FROM media')[0] || {}).n || 0);
  ui.log('\n📊 Mídias:');
  ui.log(`   No banco: ${mediaCount} · baixadas: ${stats.downloaded} · ignoradas: ${stats.skipped} · falhas: ${stats.failed}`);
  if (stats.downloaded < mediaCount) {
    ui.warn('   ⚠️  O R2 local pode estar incompleto. Rode o sync novamente ou verifique WAF/URL pública.');
  } else {
    ui.log('   ✅ Todas as mídias do banco estão no R2 local.');
  }

  return stats;
}

module.exports = { syncMedia };
