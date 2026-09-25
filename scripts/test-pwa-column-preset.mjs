// 宽屏「对话区宽度」预设：默认值 / 本地持久化 / CSS 变量映射。
//
// 为什么要测：这是个**用户可调**且**记在本地**的设定——读崩了、默认值取错、或某个预设
// 漏了变量，用户看到的就是「设置点了没反应」或「宽度回不到默认」。这些都不该靠肉眼在
// 4K 屏上试。
import assert from "node:assert/strict";

const {
  COLUMN_PRESETS,
  COLUMN_PRESET_ORDER,
  COLUMN_PRESET_STORAGE_KEY,
  DEFAULT_COLUMN_PRESET,
  columnCssVars,
  readColumnPreset,
  writeColumnPreset,
} = await import("../mobile/pwa/src/lib/column-preset.ts");

// --- 1. 默认值：必须是「居中、左右留白对称」那一档 ------------------------------
// 这是用户的明确要求（原话：默认左右两侧有空隙、对称点）。改默认值会改变所有人的首屏观感，
// 所以把它钉住。
{
  assert.equal(DEFAULT_COLUMN_PRESET, "standard", "默认档必须是 standard");
  const spec = COLUMN_PRESETS.standard;
  assert.equal(spec.colMargin, "auto", "默认档必须居中（margin:auto → 左右留白对称）");
  assert.match(spec.colMax, /%/, "默认档应含比例（自适应），不能是写死的像素");
  assert.notEqual(spec.proseMax, "none", "默认档正文必须有可读上限");
}

// --- 2. 预设表自洽：顺序列表覆盖且不重复 ----------------------------------------
{
  const ids = Object.keys(COLUMN_PRESETS);
  assert.equal(COLUMN_PRESET_ORDER.length, ids.length, "顺序列表长度应与预设数一致");
  assert.deepEqual([...COLUMN_PRESET_ORDER].sort(), [...ids].sort(), "顺序列表应恰好覆盖全部预设（不漏、不多）");
  for (const id of COLUMN_PRESET_ORDER) {
    const spec = COLUMN_PRESETS[id];
    assert.ok(spec.label, `${id} 缺 label（面板要显示）`);
    assert.ok(spec.note, `${id} 缺 note（要把代价讲清）`);
    assert.ok(spec.colMax, `${id} 缺 colMax`);
    assert.ok(spec.colMargin !== undefined, `${id} 缺 colMargin`);
    assert.ok(spec.proseMax, `${id} 缺 proseMax`);
  }
}

// --- 3. 「拉满」档：真的没有留白（这是用户要的那个能力） -------------------------
{
  const full = COLUMN_PRESETS.full;
  assert.equal(full.colMax, "100%", "拉满档列宽应占满");
  assert.equal(full.colMargin, "0", "拉满档不能居中（否则仍有左右留白）");
  assert.equal(full.proseMax, "none", "拉满档正文不再限宽");
}

// --- 4. CSS 变量映射：三个变量名与取值都要对 ------------------------------------
{
  assert.deepEqual(
    Object.keys(columnCssVars("standard")).sort(),
    ["--thread-col-max", "--thread-col-margin", "--thread-prose-max"].sort(),
    "应只注入这三个 CSS 变量",
  );
  for (const id of COLUMN_PRESET_ORDER) {
    const vars = columnCssVars(id);
    assert.equal(vars["--thread-col-max"], COLUMN_PRESETS[id].colMax, `${id}: col-max 映射`);
    assert.equal(vars["--thread-col-margin"], COLUMN_PRESETS[id].colMargin, `${id}: col-margin 映射`);
    assert.equal(vars["--thread-prose-max"], COLUMN_PRESETS[id].proseMax, `${id}: prose-max 映射`);
  }
}

// --- 5. 无 localStorage（Node / 隐私模式）：读回默认、写不抛 ----------------------
{
  assert.equal(typeof globalThis.localStorage, "undefined", "前提：Node 里没有 localStorage");
  assert.equal(readColumnPreset(), DEFAULT_COLUMN_PRESET, "取不到 storage 时回默认值，且不得抛");
  assert.doesNotThrow(() => writeColumnPreset("full"), "写失败必须静默（写不了不影响使用）");
}

// --- 6. 有 localStorage：读写往返 + 非法值回退 -----------------------------------
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
  };
  try {
    assert.equal(readColumnPreset(), DEFAULT_COLUMN_PRESET, "空存储 → 默认");

    writeColumnPreset("full");
    assert.equal(store.get(COLUMN_PRESET_STORAGE_KEY), "full", "写入用的键名要固定（换名字会让老用户的设置丢失）");
    assert.equal(readColumnPreset(), "full", "写进去能读回来");

    store.set(COLUMN_PRESET_STORAGE_KEY, "garbage");
    assert.equal(readColumnPreset(), DEFAULT_COLUMN_PRESET, "非法值回默认（而不是返回 undefined 让 CSS 变量变空）");

    store.set(COLUMN_PRESET_STORAGE_KEY, "toString"); // 原型链上的键名不能被当合法预设
    assert.equal(readColumnPreset(), DEFAULT_COLUMN_PRESET, "只认自己的键（Object.hasOwnProperty 守卫）");
  } finally {
    delete globalThis.localStorage;
  }
}

console.log("ok 1 - 宽度预设：默认对称居中 / 预设表自洽 / 拉满无留白 / CSS 变量映射");
console.log("ok 2 - 持久化：无 storage 回默认、写失败静默、非法值回退");
console.log("pwa column preset tests passed");
