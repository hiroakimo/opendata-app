# pipeline

上流（各区の公開データ）から D1 / R2 へ取り込む処理。Worker 本体（src/）とは独立している。

## 構成

```
pipeline/
  registry.json            区・系列・dataset_key・置き場所の一覧（区を足すときはまずここ）
  wards/{ward}/            区ごと。ward はローマ字（meguro, minato …）
    towns.json             町丁目マスタ（key_code を固定。区内の全系列で共通）
    exceptions.json        原本の既知の不整合（補正せず、フラグ付きで通す）
    {series}/              系列ごと（取得元の単位）
      fetch.py / survey.py 取得（読み取りのみ）
      parse.py             検証 → 正規化（失敗したら何も書かない）
      build_load.py        D1 投入SQL と R2 アップロード手順の生成
  watch/                   上流の更新検知（CKAN）
patches/                   適用済みのパッチ（履歴）
tools/                     単発の調査・確認
work/                      生成物・原本の控え（Git 管理外）。work/{ward}/{series}/ に揃える
```

## 決まりごと

- 実行はリポジトリ直下から行う（例: `python pipeline/wards/minato/ckan/parse.py`）
- ファイル名に区名を入れない。区と系列はフォルダで表す
- key_code は `{区コード先頭5桁}{町の連番3桁}{丁目3桁}`。一度振った番号は変えない
- R2 の認証情報は環境変数（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）。コードに書かない

## 区を追加する手順

1. `registry.json` に区と系列を追記
2. `pipeline/wards/{ward}/{series}/` を作り、取得 → 調査 → パーサー → 投入SQL の順に作る
3. `towns.json` を作成して key_code を固定し、コミット
