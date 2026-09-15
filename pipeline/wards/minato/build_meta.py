#!/usr/bin/env python3
"""
港区専用ページのためのメタデータ SQL を生成する（D1 には接続しない）。

使い方（リポジトリ直下で）
  python pipeline/wards/minato/build_meta.py
生成物
  work/minato/meta/meta.sql
    - area_groups: 町丁目 → 地区（towns.json の district）
    - datasets: minato_noage にライセンスと出典表示を設定（is_public は 0 のまま）
    - source_files: minato_5y の原本は配布停止（区ホームページ掲載資料のため）

前提: migrations/0008_minato_views.sql 適用済み
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path("work/minato/meta")

CKAN_URL = "https://opendata.city.minato.tokyo.jp/dataset/jinko-chochomokubetsu"
LICENSE = "港区オープンデータ利用規約（政府標準利用規約 第2.0版準拠・CC BY 4.0 互換）"
LICENSE_URL = "https://www.city.minato.tokyo.jp/ictsuishintan/opendata/kiyaku.html"
ATTRIBUTION = f"「港区の町丁目別人口・世帯数（住民基本台帳に基づく）」（港区）（{CKAN_URL}）を加工して作成"
HOLD_5Y = ("港区ホームページの掲載資料。ホームページの利用案内で転載には区への連絡が求められているため、"
           "利用条件の確認が取れるまで原本は配布しない。")


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def label(name):
    return name.replace("総合支所管内", "")


def main():
    towns = json.loads((HERE / "towns.json").read_text(encoding="utf-8"))["towns"]
    if len(towns) != 117 or not all(t.get("key_code") and t.get("district") for t in towns):
        sys.exit("中止: towns.json が 117件・key_code/district 付きでない")
    rows = [f"({q(t['key_code'])}, 'district', {q(t['district'])}, {q(label(t['district']))}, {i})"
            for i, t in enumerate(towns, start=1)]
    S = [
        "-- 生成: pipeline/wards/minato/build_meta.py",
        "DELETE FROM area_groups WHERE group_kind = 'district' AND key_code LIKE '13103%';",
        "INSERT INTO area_groups (key_code, group_kind, group_name, group_label, sort_order) VALUES\n"
        + ",\n".join(rows) + ";",
        "",
        f"UPDATE datasets SET license = {q(LICENSE)}, license_url = {q(LICENSE_URL)},"
        f" attribution = {q(ATTRIBUTION)} WHERE dataset_key = 'minato_noage';",
        f"UPDATE source_files SET distributable = 0, hold_reason = {q(HOLD_5Y)}"
        " WHERE dataset = 'minato_web:chocho_nenrei_5y';",
        "",
    ]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "meta.sql").write_text("\n".join(S), encoding="utf-8")
    labels = sorted({label(t["district"]) for t in towns}, key=[label(t["district"]) for t in towns].index)
    print(f"生成しました: {OUT / 'meta.sql'}（町丁目 {len(rows)}、地区 {labels}）")


if __name__ == "__main__":
    main()
