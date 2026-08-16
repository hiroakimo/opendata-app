-- migrations/0002_source_files_provenance.sql
--
-- source_files に配信元の来歴を持たせる。
--
-- ── なぜ必要か ──
--
-- 同期層（r2_sync_v2.py）は resource_id で同一性を判定し、
-- source_last_modified で更新を検知し、supersedes で世代を連結している。
-- ところが normalize.py が D1 に書く時点でこれらが全部落ちていた。
--
-- その結果 D1 だけを見ても
--   ・同じ月に複数ファイルがあるとき、どれが最新なのか
--   ・あるファイルが何を置き換えたのか
--   ・配信元がいつ更新したのか
-- のいずれも判断できず、2026-08 の事故では JSONL を手で追う羽目になった。
--
-- ── 設計方針 ──
--
-- 「履歴は残すが、最新更新日のものを正とする」を D1 上で表現する。
--   ・行は消さない（is_current=0 にするだけ）
--   ::  同じ (dataset_key相当, reference_date, granularity) の中で
--       is_current=1 は高々1件
--   ・どれが正かは source_last_modified の新しさで決める
--
-- SQLite は ALTER TABLE ADD COLUMN のみ対応。既存行には NULL / 既定値が入る。

ALTER TABLE source_files ADD COLUMN resource_id TEXT;
ALTER TABLE source_files ADD COLUMN source_last_modified TEXT;
ALTER TABLE source_files ADD COLUMN supersedes TEXT;

-- どのファイルがその期間の「正」か。
-- 既存行はいったん全部 1 にしておき、normalize.py 側で振り直す。
ALTER TABLE source_files ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;

-- ファイル名由来の基準日と、シート内の調査年月日が食い違った場合に
-- 後者を採用したことを記録する。2026-08 の事故はこれが無くて気づけなかった。
ALTER TABLE source_files ADD COLUMN filename_date TEXT;
ALTER TABLE source_files ADD COLUMN date_source TEXT;   -- 'sheet' / 'filename'

CREATE INDEX IF NOT EXISTS idx_sf_current
    ON source_files (reference_date, granularity, is_current);

CREATE INDEX IF NOT EXISTS idx_sf_resource
    ON source_files (resource_id, source_last_modified);

-- ---------------------------------------------------------------------
-- 既知の食い違いを記録しておく。
-- 2026-08 分として配信された dc536e89 は、中身が 2026-06 だった。
-- 次の取り込みで normalize.py が上書きするが、それまでの間も
-- カタログ上で誤解が生じないようにしておく。
-- ---------------------------------------------------------------------
UPDATE source_files
   SET filename_date = '2026-08-01',
       date_source   = 'sheet',
       is_current    = 0,
       skip_reason   = COALESCE(skip_reason || ' / ', '')
                    || '配信元のファイル名は 20260801 だが内容は 2026-06 分だった。'
                    || '配信元がその後さらに差し替えたため、この世代は採用しない。'
 WHERE sha256 = 'dc536e89fe9f6689f48fca2b8ce8c0c9b6f581898160fc3e317ee2394f93e6ab';

-- 外部リンクの計算式で値が取れなかった初回ファイル。
-- status='ingested' / row_count=27984 と記録されているが観測行は0件で、
-- 記録と実態が食い違っている。
UPDATE source_files
   SET status        = 'skipped',
       row_count     = 0,
       is_current    = 0,
       filename_date = '2026-08-01',
       skip_reason   = 'セルの値が外部ブックへのリンク計算式で、数値を取得できなかった。'
 WHERE sha256 = '642a756a1899997ea7fdefa0e6a32d42c7a7f5fc2f3c015615d8b980193d8c65';
