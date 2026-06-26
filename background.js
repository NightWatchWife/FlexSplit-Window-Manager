// background.js (Service Worker / Manifest V3)
// popup.js から受け取った分割数と画面サイズをもとに、
// 対象範囲のタブを先頭からN個取り出し、均等に整列させる。

// MAXモード時の分割数の上限（開いているタブが多くても、ここまでで打ち止め）
const MAX_SPLIT = 10;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  if (message.type === "SPLIT_WINDOWS") {
    splitWindows(message)
      .then((usedCount) => sendResponse({ ok: true, count: usedCount }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // 非同期で sendResponse を呼ぶため true を返す
  }

  if (message.type === "MERGE_WINDOWS") {
    mergeWindows(message)
      .then((mergedCount) => sendResponse({ ok: true, count: mergedCount }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

/**
 * 対象範囲(scope)に応じてタブを取得し、ウィンドウ順→index順で並べて返す。
 * split / merge の両方で共有する。
 * @param {{scope:string, availWidth:number, availHeight:number, availLeft:number, availTop:number}} opts
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
async function getScopedTabs(opts) {
  const {
    scope = "active-monitor",
    availWidth,
    availHeight,
    availLeft = 0,
    availTop = 0,
  } = opts;

  let tabs = await chrome.tabs.query({ windowType: "normal" });

  if (scope === "active-window") {
    // 今フォーカスしている通常ウィンドウ1つに限定。
    // （拡張のポップアップは type:"popup" のため windowTypes:["normal"] で除外され、
    //  直前に操作していたブラウザウィンドウが正しく取れる）
    const focused = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    tabs = tabs.filter((t) => t.windowId === focused.id);
  } else if (scope === "active-monitor") {
    // ポップアップを開いたモニターの作業領域内にあるウィンドウだけに限定。
    // 判定はウィンドウ中心点がモニター矩形に入っているかで行う。
    const monLeft = availLeft;
    const monTop = availTop;
    const monRight = availLeft + availWidth;
    const monBottom = availTop + availHeight;

    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const onMonitor = new Set(
      wins
        .filter((w) => {
          const cx = w.left + w.width / 2;
          const cy = w.top + w.height / 2;
          return cx >= monLeft && cx < monRight && cy >= monTop && cy < monBottom;
        })
        .map((w) => w.id)
    );
    tabs = tabs.filter((t) => onMonitor.has(t.windowId));
  }
  // scope === "all" の場合は絞り込みなし（全ウィンドウ対象）

  // ウィンドウ順 → ウィンドウ内のindex順 で安定的に並べ替え
  tabs.sort((a, b) => {
    if (a.windowId !== b.windowId) return a.windowId - b.windowId;
    return a.index - b.index;
  });
  return tabs;
}

/**
 * ウィンドウを分割整列するメイン処理
 * @param {{count:number|"max", scope:string, availWidth:number, availHeight:number, availLeft:number, availTop:number}} opts
 * @returns {Promise<number>} 実際に使った分割数
 */
async function splitWindows(opts) {
  const { count, availWidth, availHeight, availLeft = 0, availTop = 0 } = opts;

  // "max" 以外は正の整数（2以上）であること
  if (count !== "max" && (!Number.isInteger(count) || count < 2)) {
    throw new Error(chrome.i18n.getMessage("errInvalidCount"));
  }

  const tabs = await getScopedTabs(opts);

  // 実際に使う分割数を決定する。
  // "max" は開いているタブ数（上限 MAX_SPLIT）、それ以外は指定値。
  const splitCount = count === "max" ? Math.min(tabs.length, MAX_SPLIT) : count;

  // --- エラーハンドリング: タブ数が分割数より少ない場合 ---
  // （max でもタブが1つしかなければ分割できないので、最低2を要求する）
  if (tabs.length < splitCount || splitCount < 2) {
    throw new Error(
      chrome.i18n.getMessage("errNotEnoughTabs", [
        String(Math.max(splitCount, 2)),
        String(tabs.length),
      ])
    );
  }

  // 先頭からN個だけ使用
  const targetTabs = tabs.slice(0, splitCount);

  // --- 隙間対策 ---
  // Windows 10/11 のウィンドウには周囲に不可視のリサイズ枠＋影があり、
  // 指定した left/width のまま配置すると「中身」がその分内側にズレて隙間になる。
  // 各ウィンドウを枠ぶんだけ外側に広げて配置することで、見た目の中身を密着させる。
  // 環境（DPI/OS）により最適値が変わるため定数で調整可能（0 で補正なし）。
  const BORDER = 8; // 不可視枠の補正量(px)。隙間が残る/重なる場合はここを増減。

  // 列ごとの「理想の中身位置」を端数なく分配する。
  // baseWidth で割り、最後の列が余りを吸収することで右端の隙間をなくす。
  const baseWidth = Math.floor(availWidth / splitCount);

  for (let i = 0; i < targetTabs.length; i++) {
    const tab = targetTabs[i];

    // この列の「中身」が占めるべき範囲（端数なし）
    const contentLeft = availLeft + baseWidth * i;
    const contentRight =
      i === splitCount - 1
        ? availLeft + availWidth
        : availLeft + baseWidth * (i + 1);

    // 不可視枠ぶん外側へ広げた実際の指定値
    const left = contentLeft - BORDER;
    const width = contentRight - contentLeft + BORDER * 2;
    const top = availTop; // 上端はタイトルバーがあるため補正しない
    const height = availHeight + BORDER; // 下端の不可視枠ぶんだけ伸ばす

    const bounds = { left, top, width, height, state: "normal" };

    if (i === 0) {
      // 1番目: 元のウィンドウをそのまま左端へリサイズ配置
      await chrome.windows.update(tab.windowId, { ...bounds, focused: false });
    } else {
      // 2番目以降: タブを新しいウィンドウとして切り離して配置
      const newWindow = await chrome.windows.create({
        tabId: tab.id,
        left,
        top,
        width,
        height,
        focused: false,
      });
      // create 時に left/width が無視される環境向けに update で確定
      await chrome.windows.update(newWindow.id, bounds);
    }
  }

  return splitCount;
}

/**
 * 分割の逆操作。対象範囲のタブを1つのウィンドウに集約して最大化する。
 * @param {{scope:string, availWidth:number, availHeight:number, availLeft:number, availTop:number}} opts
 * @returns {Promise<number>} まとめたタブ数
 */
async function mergeWindows(opts) {
  const tabs = await getScopedTabs(opts);

  // 集約先ウィンドウを決める。今フォーカス中のウィンドウが対象内ならそれを優先し、
  // そうでなければ対象の先頭ウィンドウにまとめる。
  const windowIds = [...new Set(tabs.map((t) => t.windowId))];
  let targetId = windowIds[0];
  try {
    const focused = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (windowIds.includes(focused.id)) targetId = focused.id;
  } catch (_) {
    /* getLastFocused が失敗しても先頭を使う */
  }

  // すでに1ウィンドウにまとまっている場合はまとめる対象がない。
  const moveIds = tabs
    .filter((t) => t.windowId !== targetId && !t.pinned)
    .map((t) => t.id);
  if (moveIds.length === 0) {
    throw new Error(chrome.i18n.getMessage("errNothingToMerge"));
  }

  // 集約先の末尾へ移動してから最大化・フォーカス。
  await chrome.tabs.move(moveIds, { windowId: targetId, index: -1 });
  await chrome.windows.update(targetId, { state: "maximized", focused: true });

  return tabs.length;
}
