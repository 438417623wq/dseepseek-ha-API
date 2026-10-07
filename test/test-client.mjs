/**
 * Tests for the browser half (`client.js`).
 *
 * The bundle is a hand-written ModuleLoader registration, so it can be exercised
 * in plain Node: stub `window.__ModuleLoader__` to capture the registration, then
 * run the factory with a stub `react` and a stub plugin context. That covers the
 * two things a browser would otherwise be the only witness to — that the bundle
 * registers under the right id with the right exports, and that the settings page
 * builds the provider-grouped roster the host API actually feeds it.
 *
 * Run: node test-client.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// The suite lives in test/ but the bundle it exercises is at the package root.
const SOURCE = readFileSync(join(here, "..", "client.js"), "utf8");
/** Bumped per load so Node's module cache cannot serve a stale registration. */
let loadCount = 0;
/** Per-run scratch dir holding the copies the loader imports. */
const scratch = mkdtempSync(join(tmpdir(), "dsh-model-bridge-client-"));

/** Every string rendered anywhere in the tree. */
function allText(tree) {
  return flatten(tree)
    .flatMap(n => n.children ?? [])
    .filter(c => typeof c === "string");
}

// ---------------------------------------------------------------------------
// A minimal stand-in for the shell: capture the registration, then run the
// factory the way the module system would.
// ---------------------------------------------------------------------------

/**
 * Load the bundle under a stubbed shell.
 *
 * @param react - the `react` the factory will receive.
 * @returns the bundle's exports.
 */
async function loadBundle(react) {
  let registration;
  globalThis.window = { __ModuleLoader__: { load: reg => { registration = reg } } };
  // Write a fresh copy per load and import it by file URL. A `data:` URL would
  // work, but Node echoes the whole URL in any error — which for this bundle is
  // tens of kilobytes of base64 that buries the actual failure. The unique name
  // also defeats Node's module cache, which is load-bearing: a cached import
  // would never re-run the registration.
  const path = join(scratch, `bundle-${loadCount++}.mjs`);
  writeFileSync(path, SOURCE);
  await import(pathToFileURL(path).href);
  if (registration === undefined) throw new Error("bundle never called window.__ModuleLoader__.load");
  return { registration, exports: registration.factory(name => {
    if (name === "react") return react;
    throw new Error(`unexpected require("${name}")`);
  }) };
}

/**
 * A React stub that records the element tree instead of rendering it.
 *
 * `useState` walks a scripted sequence so a component can be driven into any
 * branch; `useMemo`/`useCallback` just run their function.
 */
function makeReact(sequence) {
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: "Fragment",
    useState: () => [sequence[cursor++], () => {}],
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
  };
}

/** Flatten an element tree to a list of nodes, for assertions. */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  out.push(node);
  flatten(node.children, out);
  return out;
}

/** Collect the text of every node whose className matches. */
function textsOfClass(tree, className) {
  return flatten(tree)
    .filter(n => n.props?.className === className)
    .map(n => n.children?.[0])
    .filter(v => typeof v === "string");
}

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

console.log("\n== registration contract ==");

const identity = x => x;
const bundle = await loadBundle(makeReact([]));

check("the bundle registers under the package name", bundle.registration.id === "dsh-model-bridge", bundle.registration.id);
check("the registration carries a factory", typeof bundle.registration.factory === "function");
check("exports.name matches the host half", bundle.exports.name === "model-bridge", bundle.exports.name);
check("exports.inject declares slots and locale", JSON.stringify(bundle.exports.inject) === JSON.stringify(["slots", "locale"]), JSON.stringify(bundle.exports.inject));
check("exports.apply is callable", typeof bundle.exports.apply === "function");

// ---------------------------------------------------------------------------
// apply(): slot registration and effects
// ---------------------------------------------------------------------------

console.log("\n== apply() wiring ==");

{
  const { exports } = bundle;
  const injected = [];
  const registered = [];
  const effects = [];
  const dictionaries = [];
  const ctx = {
    locale: {
      bind: () => identity,
      register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
    },
    effect: fn => { const d = fn(); effects.push(d); return d },
    slots: {
      inject: (name, cb) => { injected.push(name); cb() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
  };
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, style: {}, remove() {}, textContent: "" }),
    head: { appendChild() {} },
    documentElement: { lang: "zh" },
  };

  exports.apply(ctx);

  check("it injects into settings.section", injected.includes("settings.section"), JSON.stringify(injected));
  check("it registers exactly one section", registered.length === 1, `${registered.length}`);
  check("the section is named settings.section", registered[0]?.options?.name === "settings.section");
  check("the section id is model-bridge", registered[0]?.options?.id === "model-bridge", registered[0]?.options?.id);
  check("the section carries an order", typeof registered[0]?.options?.order === "number");
  check("the section declares a locale namespace", registered[0]?.options?.locale === "settings.modelBridge", registered[0]?.options?.locale);
  check("the label resolves to the nav string", registered[0]?.options?.label() === "nav", registered[0]?.options?.label());
  check("both dictionaries are registered", dictionaries.length === 1 && dictionaries[0].dict.zh !== undefined && dictionaries[0].dict.en !== undefined);
  check("a style element and a dictionary effect are registered", effects.length === 2, `${effects.length}`);
  check("the section component is a function", typeof registered[0]?.component === "function");
}

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

console.log("\n== settings page render ==");

/** Boot the page component with a scripted state sequence and return its tree. */
async function renderPage(sequence) {
  const react = makeReact(sequence);
  const { exports } = await loadBundle(react);
  const registered = [];
  const ctx = {
    locale: { bind: () => identity, register: () => () => {} },
    effect: fn => fn(),
    slots: { inject: (n, cb) => { cb() }, register: (o, c) => { registered.push({ o, c }); return () => {} } },
  };
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, style: {}, remove() {}, textContent: "" }),
    head: { appendChild() {} },
    documentElement: { lang: "zh" },
  };
  exports.apply(ctx);
  const element = registered[0].c({});
  return element.type(element.props);
}

const MODELS = [
  { id: "workbuddy-xdpool/deepseek-v4.1-flash", model: "deepseek-v4.1-flash", provider: "workbuddy-xdpool", providerName: "WorkBuddy XD Pool", name: "DeepSeek V4.1 Flash", inputModalities: ["text"], contextWindow: 200000, maxTokens: 32768, reasoning: true },
  { id: "workbuddy-xdpool/glm-5.3", model: "glm-5.3", provider: "workbuddy-xdpool", providerName: "WorkBuddy XD Pool", name: "GLM 5.3", inputModalities: ["text", "image"], contextWindow: 128000, maxTokens: 8192, reasoning: false },
  { id: "our-free-model/mimo-v2.6-flash-free", model: "mimo-v2.6-flash-free", provider: "our-free-model", providerName: "Our Free Model", name: "MiMo V2.6 Flash", inputModalities: ["text"], contextWindow: 1000000, maxTokens: 16384, reasoning: false },
];

function readyData(overrides = {}) {
  return {
    running: true,
    enabled: true,
    openaiBaseUrl: "http://127.0.0.1:8791/v1",
    anthropicBaseUrl: "http://127.0.0.1:8791",
    key: "k".repeat(43),
    allowed: null,
    models: MODELS,
    ...overrides,
  };
}

/** The tick control inside each model row. */
function rowTicks(tree) {
  return flatten(tree).filter(n => n.props?.className === "dmb_tick");
}

{
  // state=ready, busy=false, error="", query="", allowed=null, enabled=true
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "", null, true]);
  const sections = textsOfClass(tree, "dmb_sectionTitle");
  check("the page renders its three sections", sections.length === 3, JSON.stringify(sections));
  check("provider groups come from the data", JSON.stringify(textsOfClass(tree, "dmb_groupTitle")) === JSON.stringify(["WorkBuddy XD Pool", "Our Free Model"]), JSON.stringify(textsOfClass(tree, "dmb_groupTitle")));
  const rows = flatten(tree).filter(n => n.props?.className?.startsWith("dmb_option"));
  check("every model gets a row", rows.length === 3, `${rows.length}`);
  const ticks = rowTicks(tree);
  check("each row carries a checkbox control", ticks.length === 3, `${ticks.length}`);
  check("ticks are exposed as checkboxes", ticks.every(t => t.props.role === "checkbox"), JSON.stringify(ticks.map(t => t.props.role)));
  check("allowed=null ticks every model", ticks.every(t => t.props["aria-checked"] === true));
}

{
  // A narrowed selection ticks only the chosen row.
  const tree = await renderPage([
    { status: "ready", data: readyData({ allowed: ["workbuddy-xdpool/glm-5.3"] }) }, false, "", "", ["workbuddy-xdpool/glm-5.3"], true,
  ]);
  const ticks = rowTicks(tree);
  const ticked = ticks.filter(t => t.props["aria-checked"] === true).map(t => t.props["aria-label"]);
  check("only the selected model is ticked", JSON.stringify(ticked) === JSON.stringify(["workbuddy-xdpool/glm-5.3"]), JSON.stringify(ticked));
}

{
  // The row must not be a <button>: that is what made the model id unselectable
  // and unable to host the per-row copy control.
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "", null, true]);
  const rows = flatten(tree).filter(n => n.props?.className?.startsWith("dmb_option"));
  check("a model row is not a button", rows.every(r => r.type !== "button"), JSON.stringify(rows.map(r => r.type)));
  // The id text stays selectable, and the copy controls exist per row.
  const ids = flatten(tree).filter(n => n.props?.className === "dmb_id");
  check("the model id is rendered as text", ids.length === 3, `${ids.length}`);
  // The id must carry no click handler, or dragging to select it would toggle.
  check("the id has no click handler", ids.every(n => n.props.onClick === undefined), JSON.stringify(ids.map(n => typeof n.props.onClick)));
  const rowCopies = flatten(tree).filter(n => String(n.props?.className ?? "").includes("dmb_rowCopy"));
  check("each row carries its own copy control", rowCopies.length === 3, `${rowCopies.length}`);
  check("row copy controls carry the model id as their value", rowCopies.every(c => typeof c.props?.value === "string" && c.props.value.includes("/")), JSON.stringify(rowCopies.map(c => c.props?.value)));
}

{
  // "Copy all" must copy exactly the exposed set — not the whole catalog, and
  // not an empty string when nothing is ticked.
  const all = await renderPage([{ status: "ready", data: readyData() }, false, "", "", null, true]);
  const allCopy = flatten(all).find(n => typeof n.type === "function" && n.type.name === "CopyButton" && n.props.value.includes("\n"));
  check("copy-all is present", allCopy !== undefined);
  check("copy-all lists every exposed model, one per line", allCopy?.props.value === MODELS.map(m => m.id).join("\n"), JSON.stringify(allCopy?.props.value));
  check("copy-all is enabled when something is exposed", allCopy?.props.disabled === false);

  const narrowed = await renderPage([
    { status: "ready", data: readyData({ allowed: ["workbuddy-xdpool/glm-5.3"] }) }, false, "", "", ["workbuddy-xdpool/glm-5.3"], true,
  ]);
  const narrowCopy = flatten(narrowed).find(n => typeof n.type === "function" && n.type.name === "CopyButton" && n.props.value.includes("glm"));
  check("copy-all follows the selection", narrowCopy?.props.value === "workbuddy-xdpool/glm-5.3", JSON.stringify(narrowCopy?.props.value));

  const none = await renderPage([{ status: "ready", data: readyData({ allowed: [] }) }, false, "", "", [], true]);
  const noneCopy = flatten(none).find(n => typeof n.type === "function" && n.type.name === "CopyButton" && n.props.disabled === true);
  check("copy-all is disabled with nothing ticked", noneCopy !== undefined);
}

{
  // Metadata tags: vision, reasoning, context and output.
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "", null, true]);
  const tags = new Set(textsOfClass(tree, "dmb_tag"));
  check("a vision model is tagged", tags.has("tag.vision"));
  check("a reasoning model is tagged", tags.has("tag.thinking"));
  check("context windows are abbreviated", tags.has("tag.context 200K") && tags.has("tag.context 1M"), JSON.stringify([...tags]));
  check("max output is abbreviated", tags.has("tag.output 33K"), JSON.stringify([...tags]));
}

{
  // A stopped gateway still renders, showing the stopped state.
  const tree = await renderPage([{ status: "ready", data: readyData({ running: false, enabled: false }) }, false, "", "", null, false]);
  const states = flatten(tree).filter(n => n.props?.className === "dmb_state");
  check("a stopped gateway renders one state caption", states.length === 1, `${states.length}`);
  check("the caption says stopped", allText(states[0]).includes("stopped"), JSON.stringify(allText(states[0])));
  check("the status dot is not lit", flatten(states[0]).some(n => n.props?.className === "dmb_dot") && !flatten(states[0]).some(n => String(n.props?.className).includes("dmb_dotOn")));
  // `Switch` is a function component, so the stub records the element rather
  // than its rendered button; assert on the props it was given.
  const switches = flatten(tree).filter(n => typeof n.type === "function" && n.type.name === "Switch");
  check("the switch is rendered", switches.length === 1, `${switches.length}`);
  check("the switch reflects the disabled state", switches[0]?.props?.checked === false, JSON.stringify(switches[0]?.props?.checked));
}

{
  // An empty roster says so rather than rendering an empty box.
  const tree = await renderPage([{ status: "ready", data: readyData({ models: [] }) }, false, "", "", null, true]);
  check("an empty roster renders its message", textsOfClass(tree, "dmb_empty").includes("noModels"), JSON.stringify(textsOfClass(tree, "dmb_empty")));
}

{
  // The loading and error branches. Both run their hooks before returning, so
  // the scripted sequence must supply every slot, not just the first.
  const loading = await renderPage([{ status: "loading" }, false, "", "", null, true]);
  check("the loading branch renders", textsOfClass(loading, "dmb_empty").includes("loading"));
  const errored = await renderPage([{ status: "error", error: "boom" }, false, "", "", null, true]);
  check("the error branch renders a retry", allText(errored).includes("retry"), JSON.stringify(allText(errored)));
}

{
  // The connection fields expose the three values a tool needs. `Field` is a
  // function component, so assert on the props it received.
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "", null, true]);
  const fields = flatten(tree).filter(n => typeof n.type === "function" && n.type.name === "Field");
  const values = fields.map(f => f.props.value);
  check("three connection fields are rendered", fields.length === 3, `${fields.length}`);
  check("the OpenAI base URL is shown", values.includes("http://127.0.0.1:8791/v1"), JSON.stringify(values));
  check("the Anthropic base URL is shown", values.includes("http://127.0.0.1:8791"));
  check("the key is passed to the masked field", values.some(v => typeof v === "string" && v.length === 43), JSON.stringify(values.map(v => v?.length)));
}

{
  // The key field masks by default. Render the page, take the key `Field` out of
  // the tree, and invoke it: the bundle's own `useState` continues down the same
  // scripted sequence, so the trailing two slots are Field's (shown, done).
  const react = makeReact([{ status: "ready", data: readyData() }, false, "", "", null, true, false, false]);
  const { exports } = await loadBundle(react);
  const registered = [];
  const ctx = {
    locale: { bind: () => identity, register: () => () => {} },
    effect: fn => fn(),
    slots: { inject: (n, cb) => { cb() }, register: (o, c) => { registered.push({ o, c }); return () => {} } },
  };
  globalThis.document = { createElement: () => ({ setAttribute() {}, style: {}, remove() {}, textContent: "" }), head: { appendChild() {} }, documentElement: { lang: "zh" } };
  exports.apply(ctx);
  const page = registered[0].c({});
  const tree = page.type(page.props);
  const keyField = flatten(tree).find(n => typeof n.type === "function" && n.type.name === "Field" && n.props.label === "field.key");
  check("the key field is present", keyField !== undefined);
  const fieldTree = keyField.type(keyField.props);
  const rendered = allText(fieldTree);
  check("the key is masked by default", rendered.some(v => v.startsWith("•")), JSON.stringify(rendered));
  check("masking keeps only the last six characters", rendered.some(v => v.startsWith("•") && v.endsWith("kkkkkk")), JSON.stringify(rendered));
  check("a reveal control is offered", rendered.includes("reveal"), JSON.stringify(rendered));
}

// ---------------------------------------------------------------------------
// Search filter
// ---------------------------------------------------------------------------

console.log("\n== search ==");

{
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "mimo", null, true]);
  const rows = flatten(tree).filter(n => n.props?.className?.startsWith("dmb_option"));
  check("search narrows the roster", rows.length === 1 && rows[0].props.title === "our-free-model/mimo-v2.6-flash-free", `${rows.length}`);
  // The copy controls must follow the filter, so a filtered list copies only
  // what is on screen... except "copy all", which stays the exposed set.
  const ids = flatten(tree).filter(n => n.props?.className === "dmb_id").map(n => n.children?.[0]);
  check("the filtered row shows its id", JSON.stringify(ids) === JSON.stringify(["our-free-model/mimo-v2.6-flash-free"]), JSON.stringify(ids));
}

{
  const tree = await renderPage([{ status: "ready", data: readyData() }, false, "", "zzz-no-match", null, true]);
  check("a fruitless search says so", textsOfClass(tree, "dmb_empty").includes("noMatch"), JSON.stringify(textsOfClass(tree, "dmb_empty")));
}

// ---------------------------------------------------------------------------
// The copy control itself
// ---------------------------------------------------------------------------

console.log("\n== copy control ==");

{
  // Drive CopyButton directly: click it and prove the clipboard receives the
  // value. The page renders first, so the sequence covers its state slots before
  // CopyButton's own `done` slot.
  const react = makeReact([{ status: "ready", data: readyData() }, false, "", "", null, true, false]);
  const { exports } = await loadBundle(react);
  const registered = [];
  const ctx = {
    locale: { bind: () => identity, register: () => () => {} },
    effect: fn => fn(),
    slots: { inject: (n, cb) => { cb() }, register: (o, c) => { registered.push({ o, c }); return () => {} } },
  };
  globalThis.document = { createElement: () => ({ setAttribute() {}, style: {}, remove() {}, textContent: "" }), head: { appendChild() {} }, documentElement: { lang: "zh" } };

  // Capture what the control would put on the clipboard. `navigator` is a
  // getter-only global in Node, so it has to be redefined rather than assigned.
  const written = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async text => { written.push(text) } } },
  });

  exports.apply(ctx);
  const page = registered[0].c({});
  const tree = page.type(page.props);
  const copy = flatten(tree).find(n => typeof n.type === "function" && n.type.name === "CopyButton" && n.props.value.includes("/"));
  check("a copy control is reachable in the tree", copy !== undefined);

  const button = copy.type(copy.props);
  check("the control renders a button", button.type === "button", String(button.type));
  check("it is labelled", Array.isArray(button.children) && typeof button.children[0] === "string" && button.children[0].length > 0, JSON.stringify(button.children));

  // Clicking must copy the value and must not bubble to the row's own handler.
  let bubbled = false
  await button.props.onClick({ stopPropagation: () => { bubbled = true } })
  check("clicking copies the model id", written.includes(copy.props.value), JSON.stringify(written))
  check("clicking stops propagation so the row does not toggle", bubbled === true)
}

{
  // The legacy path must be used when the async clipboard API is unavailable.
  const react = makeReact([{ status: "ready", data: readyData() }, false, "", "", null, true, false]);
  const { exports } = await loadBundle(react);
  const registered = [];
  const ctx = {
    locale: { bind: () => identity, register: () => () => {} },
    effect: fn => fn(),
    slots: { inject: (n, cb) => { cb() }, register: (o, c) => { registered.push({ o, c }); return () => {} } },
  };
  const selected = [];
  globalThis.document = {
    createElement: () => ({
      setAttribute() {}, style: {}, remove() {}, set value(v) { selected.push(v) }, get value() { return "" },
      select() {},
    }),
    execCommand: () => true,
    body: { appendChild() {} },
    head: { appendChild() {} },
    documentElement: { lang: "zh" },
  };
  // No clipboard API at all, to force the legacy path.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  exports.apply(ctx);
  const page = registered[0].c({});
  const tree = page.type(page.props);
  const copy = flatten(tree).find(n => typeof n.type === "function" && n.type.name === "CopyButton" && n.props.value.includes("/"));
  const button = copy.type(copy.props);
  await button.props.onClick({ stopPropagation: () => {} });
  check("the fallback path still copies", selected.includes(copy.props.value), JSON.stringify(selected));
}

console.log(`\n${"=".repeat(60)}`);
console.log(`passed ${passed}, failed ${failed}`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
