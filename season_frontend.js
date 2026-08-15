/* =====================================================================
 *  季節変動タブ フロント側の差分
 *  analysis.js の analyzePage() 内、該当箇所にそれぞれ貼る。
 * ===================================================================== */


/* ---------------------------------------------------------------------
 * [1] タブ追加  ── 355行目 `増減率ランキング` の直後
 * ------------------------------------------------------------------- */
/*
  <button class="tab" role="tab" data-p="season" aria-selected="false">季節変動</button>
*/


/* ---------------------------------------------------------------------
 * [2] パネル追加  ── `<section class="panel" id="p-rank">` ブロックの直後
 * ------------------------------------------------------------------- */
/*
<section class="panel" id="p-season">
  <div class="ctl">
    <div><label>表示</label>
      <select id="s-mode">
        <option value="strength">振幅ランキング（町丁）</option>
        <option value="profile">12ヶ月プロファイル</option>
        <option value="age">年齢階級別の内訳</option>
      </select>
    </div>
    <div><label>町丁</label><select id="s-area" disabled></select></div>
    <div><label>月</label><select id="s-month" disabled></select></div>
    <button class="go" id="s-go">集計</button>
  </div>
  <div id="s-out"></div>
</section>
*/


/* ---------------------------------------------------------------------
 * [3] 描画関数  ── drawRank() の後ろに追加
 * ------------------------------------------------------------------- */

function pctBar(v, max){
  /* 0 を中心に左右へ伸びる棒。負を左、正を右に置く。
     季節変動は増減の向きが意味を持つので、絶対値の棒にはしない。 */
  var W = 260, half = W / 2;
  var w = Math.min(Math.abs(v) / max, 1) * half;
  var x = v < 0 ? half - w : half;
  var col = v < 0 ? "var(--warn)" : "var(--acc)";
  return '<svg width="' + W + '" height="14" style="vertical-align:middle">'
       + '<line x1="' + half + '" y1="0" x2="' + half + '" y2="14" stroke="var(--line)"/>'
       + '<rect x="' + x + '" y="3" width="' + w + '" height="8" fill="' + col + '"/>'
       + '</svg>';
}

function consistency(above, years){
  /* 再現性の言い換え。数字だけだと解釈されないので短い語を添える。
     ここは事実の範囲。示唆は要件6側で出す。 */
  if (!years) return "-";
  var r = above / years;
  var lab = (r >= 0.9 || r <= 0.1) ? "ほぼ毎年"
          : (r >= 0.75 || r <= 0.25) ? "多くの年"
          : "年により異なる";
  return above + "/" + years + "年 <span class='mut'>" + lab + "</span>";
}

function drawSeason(d, box){
  if (!d.rows || !d.rows.length){
    box.appendChild(el("div", {class:"card"}, "該当するデータがありません"));
    return;
  }

  var html = "";

  if (d.mode === "strength"){
    html += "<h3>季節変動の大きい町丁</h3>";
    html += "<p class='mut'>年間で最も高い月と低い月の差。トレンド除去後の比率で比較している。</p>";
    html += "<table><thead><tr><th>町丁</th><th>振幅</th><th>最高月</th><th>最低月</th></tr></thead><tbody>";
    var mx = Math.max.apply(null, d.rows.map(function(r){ return r.amplitude_pct; }));
    d.rows.forEach(function(r){
      html += "<tr><td>" + r.area_name + "</td>"
            + "<td>" + r.amplitude_pct.toFixed(2) + "%<br>"
            + '<svg width="180" height="10"><rect x="0" y="2" width="'
            + (r.amplitude_pct / mx * 180) + '" height="6" fill="var(--acc)"/></svg></td>'
            + "<td>" + Number(r.peak_month) + "月 (" + r.peak_pct.toFixed(1) + "%)</td>"
            + "<td>" + Number(r.trough_month) + "月 (" + r.trough_pct.toFixed(1) + "%)</td></tr>";
    });
    html += "</tbody></table>";

  } else if (d.mode === "profile"){
    html += "<h3>12ヶ月プロファイル</h3>";
    html += "<p class='mut'>各月の人口がトレンド比で何%高いか。0%が年間の平均的な水準。</p>";
    var mp = Math.max.apply(null, d.rows.map(function(r){ return Math.abs(r.pct_vs_trend); }));
    html += "<table><thead><tr><th>月</th><th>トレンド比</th><th></th><th>上回った年</th></tr></thead><tbody>";
    d.rows.forEach(function(r){
      html += "<tr><td>" + Number(r.month) + "月</td>"
            + "<td style='text-align:right'>" + r.pct_vs_trend.toFixed(2) + "%</td>"
            + "<td>" + pctBar(r.pct_vs_trend, mp) + "</td>"
            + "<td>" + consistency(r.n_above, r.n_years) + "</td></tr>";
    });
    html += "</tbody></table>";

  } else {
    html += "<h3>年齢階級別の内訳</h3>";
    html += "<p class='mut'>選んだ月の、階級ごとのトレンド比。特定の階級だけが動いていれば、"
          + "その年齢層に固有の要因が働いている可能性がある。</p>";
    var ma = Math.max.apply(null, d.rows.map(function(r){ return Math.abs(r.pct_vs_trend); }));
    html += "<table><thead><tr><th>年齢</th><th>トレンド比</th><th></th><th>上回った年</th></tr></thead><tbody>";
    d.rows.forEach(function(r){
      html += "<tr><td>" + r.age_class + "</td>"
            + "<td style='text-align:right'>" + r.pct_vs_trend.toFixed(2) + "%</td>"
            + "<td>" + pctBar(r.pct_vs_trend, ma) + "</td>"
            + "<td>" + consistency(r.n_above, r.n_years) + "</td></tr>";
    });
    html += "</tbody></table>";
  }

  box.appendChild(card(html));

  /* 既知の問題。notes とは別枠にする。
     notes は「この集計の読み方」、issues は「データ自体の未解決事項」。 */
  if (d.issues && d.issues.length){
    var ih = "<h4>このデータの既知の問題</h4><ul>";
    d.issues.forEach(function(i){
      ih += "<li><strong>" + i.title + "</strong><br><span class='mut'>" + i.detail + "</span></li>";
    });
    ih += "</ul>";
    box.appendChild(card(ih));
  }
}


/* ---------------------------------------------------------------------
 * [4] run() に分岐追加  ── else { out = $("r-out"); ... } の前に挿入
 * ------------------------------------------------------------------- */
/*
  } else if (kind === "season"){
    out = $("s-out");
    url = "/api/q/seasonality?dataset=" + encodeURIComponent(DS)
        + "&mode=" + $("s-mode").value
        + ($("s-area").value ? "&key_code=" + $("s-area").value : "")
        + "&month=" + $("s-month").value;
*/

/* 同じく run() 内の描画分岐。else drawRank(d, out); の前に：
    else if (kind === "season") drawSeason(d, out);
*/


/* ---------------------------------------------------------------------
 * [5] イベント登録  ── $("r-go") の行の後ろ
 * ------------------------------------------------------------------- */
/*
$("s-go").addEventListener("click", function(){ run("season"); });
$("s-mode").addEventListener("change", syncSeason);

function syncSeason(){
  var m = $("s-mode").value;
  $("s-area").disabled  = (m === "strength");
  $("s-month").disabled = (m !== "age");
}
*/


/* ---------------------------------------------------------------------
 * [6] 初期化  ── META 取得後、既存の fill() を呼んでいる箇所に追加
 * ------------------------------------------------------------------- */
/*
  fill($("s-area"), META.areas, "key_code", "area_name");
  var mo = $("s-month");
  for (var i = 1; i <= 12; i++){
    var v = ("0" + i).slice(-2);
    mo.appendChild(el("option", {value: v}, i + "月"));
  }
  mo.value = "09";
  syncSeason();
*/
