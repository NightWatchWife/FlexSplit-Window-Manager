// popup.js
// UIの操作を検知し、screen情報・分割数・対象範囲を background.js に送信する。
// 注意: Manifest V3 の background は Service Worker のため `screen` を参照できない。
//       そのため screen.availWidth / availHeight は popup 側で取得して渡す。

const statusEl = document.getElementById("status");

// MAXモードの上限分割数（background.js の MAX_SPLIT と一致させること）
const MAX_SPLIT = 10;
// MAXタイルの preview に描くペイン数（"たくさん" を示す見た目用）
const MAX_PREVIEW_PANES = 8;

// i18n ヘルパー
const t = (key, subs) => chrome.i18n.getMessage(key, subs);

/** タイルの data-count を payload 用に正規化（"max" はそのまま、他は整数） */
const normalizeCount = (raw) => (raw === "max" ? "max" : parseInt(raw, 10));

/** いま選択されている対象範囲を返す */
function currentScope() {
  const active = document.querySelector('.seg[aria-pressed="true"]');
  return active ? active.dataset.scope : "active-monitor";
}

/** ステータス表示（state: "" | "ok" | "err"） */
function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.classList.toggle("is-ok", state === "ok");
  statusEl.classList.toggle("is-err", state === "err");
}

// ---- 起動時セットアップ ----
function setup() {
  document.documentElement.lang = chrome.i18n.getUILanguage();

  // 静的文言（textContent / title）
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const msg = t(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  });

  // 各タイルに「実際に作られるレイアウト」のミニプレビューと番号を生成
  document.querySelectorAll(".tile").forEach((tile) => {
    const raw = tile.dataset.count;
    const isMax = raw === "max";
    const paneCount = isMax ? MAX_PREVIEW_PANES : parseInt(raw, 10);

    const preview = tile.querySelector(".preview");
    for (let i = 0; i < paneCount; i++) {
      const pane = document.createElement("i");
      pane.className = i === 0 ? "pane pane--active" : "pane";
      preview.appendChild(pane);
    }

    tile.querySelector(".tile-num").textContent = isMax ? t("splitMax") : raw;
    const label = isMax
      ? t("splitMaxOption", [String(MAX_SPLIT)])
      : t("splitLabel", [raw]);
    tile.setAttribute("aria-label", label);
    tile.title = label;
  });

  setStatus(t("statusIdle"), "");
}

// 対象範囲と画面情報を含む共通ペイロードを作る
function basePayload(extra) {
  return Object.assign(
    {
      scope: currentScope(),
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: screen.availLeft || 0,
      availTop: screen.availTop || 0,
    },
    extra
  );
}

// background へ送信し、応答に応じてステータス表示・自動クローズする共通処理
// @param onOk(response) → 成功時の文言を返す
function sendAction(payload, onOk) {
  setStatus("…", "");
  chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(t("statusErrorPrefix", [chrome.runtime.lastError.message]), "err");
      return;
    }
    if (!response) {
      setStatus(t("statusNoResponse"), "err");
      return;
    }
    if (response.ok) {
      setStatus(onOk(response), "ok");
      setTimeout(() => window.close(), 600);
    } else {
      setStatus(response.error || t("statusFailed"), "err");
    }
  });
}

// ---- 分割実行 ----
function requestSplit(count) {
  sendAction(basePayload({ type: "SPLIT_WINDOWS", count }), (res) => {
    const used = res.count != null ? res.count : count;
    return t("statusDone", [String(used)]);
  });
}

// ---- まとめる（分割の逆操作） ----
function requestMerge() {
  // まとめるは「全部」を選んだときのみ全モニター対象。
  // それ以外（モニター/ブラウザ）は、このモニター上のウィンドウだけを集約する。
  // （単一ウィンドウの「ブラウザ」だと集約対象がないため、モニター扱いにする）
  const scope = currentScope() === "all" ? "all" : "active-monitor";
  sendAction(basePayload({ type: "MERGE_WINDOWS", scope }), (res) =>
    t("statusMerged", [String(res.count)])
  );
}

// ---- イベント ----
// 対象範囲セグメント（単一選択）
document.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", () => {
    document
      .querySelectorAll(".seg")
      .forEach((s) => s.setAttribute("aria-pressed", String(s === seg)));
  });
});

// レイアウトタイル（クリックで即実行）
document.querySelectorAll(".tile").forEach((tile) => {
  tile.addEventListener("click", () => {
    requestSplit(normalizeCount(tile.dataset.count));
  });
});

// まとめるボタン
document.getElementById("mergeBtn").addEventListener("click", requestMerge);

setup();
