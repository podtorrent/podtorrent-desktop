# PodTorrent Design System

Source of truth: `app/ui/css/tokens.css`. Canvas code reads the same values through `app/ui/js/tokens.js` (types are in `tokens.d.ts`), which resolves the CSS variables live, so light, dark and increased contrast always match.

## Color

Semantic colors have **one meaning everywhere**:

| Token | Meaning |
| --- | --- |
| `--c-serving` | Healthy: layers loaded and answering |
| `--c-active` | Computing right now |
| `--c-degraded` | Slow link, downloading, loading |
| `--c-gap` | Offline, missing layers, error (gaps glow) |
| `--c-you` | **This Mac, always and only.** Never use it for anything else |
| `--c-net` | Network time in traces |

- **Neutrals:** `--n-0…10`, plus `--bg-*` and `--fg-1…4`. The sidebar is translucent over native `NSVisualEffectView` (Tauri `windowEffects: sidebar`), and content is opaque.
- **Accent:** `--accent` follows the macOS accent color through `-apple-system-control-accent`. It's for interactive affordances only, never for state.

## Type, space, shape

- **Type:** the system stack (SF Pro Text/Display), with `ui-monospace` for IDs and logs. The scale is `--t-1…7` (11, 12, 13, 15, 20, 28 and 44 px), and large numbers use `--track-display`. **Every live number uses `tabular-nums`** (`.num`).
- **Spacing:** a 4pt grid, `--s-1…12`.
- **Radii:** `--r-sm` 6, `--r-md` 10, `--r-lg` 14.
- **Elevation:** `--elev-card` is a hairline plus an inner highlight. `--elev-float` (shadow) is for popovers, sheets, the palette and toasts only.

## Motion

- **Durations:** `--d-fast`, `--d-base`, `--d-slow`.
- **Springs:** `--spring-snappy`, `--spring-smooth`, `--spring-gentle`, using CSS `linear()` with a cubic-bezier fallback. The JS mirror is `motion.spring`.
- **Rule:** motion communicates a state change, such as a value ticking, a node joining, a pulse along a hop, or a sheet arriving. Nothing loops while the app is idle.
- `prefers-reduced-motion`, **Reduce visual effects**, battery, thermal pressure, local inference, and an unfocused or hidden window all throttle or stop animation (`js/perf.js`).

## Components (`js/ui.js`)

| Component | API |
| --- | --- |
| Button | `button(label, {variant: primary\|danger\|ghost, size: sm\|lg\|xl, icon, kbd, tip})` |
| IconButton | `iconButton(icon, label, onclick, {kbd})`, always labeled for VoiceOver |
| Armed button | `armedButton(label, armedLabel, onconfirm)`: two-click confirm for destructive actions |
| Segmented | `segmented(options, value, onchange)`: radiogroup with arrow keys and an animated thumb |
| Toggle / Slider | `toggle(value, onchange, label)`, `slider({min,max,step,value,oninput})` |
| Tooltip | add `data-tip="…"` to any element |
| Popover | `popover().show(content, x, y)`: glass, used for graph and strip hover |
| Sheet | `sheet({title, body, footer, wide})`: modal from the top edge, with focus trap and Esc |
| Toast | `toast(text, kind, detail)` or `emit("toast", …)` |
| Badge | `badge(label, serving\|active\|degraded\|gap\|you\|neutral\|demo, {dot, pulse})` |
| Stat | `stat({label, unit, format, icon, spark})`, then `.set(value, sub, series)`. The number ticks smoothly |
| Sparkline / Empty / Skeleton / Kbd | `sparkline()`, `empty({icon,title,body,actions,tone})`, `skeleton(w,h)`, `kbd("⌘ K")` |
| Table | `.table` with a `--cols` grid template. Rows are virtualized (see `views/peers.js`) |

### Visualizations (`js/viz/`)

- `strip.js`: the Model Strip, full or `{compact:true}`
- `graph.js`: the swarm graph on Canvas 2D
- `trace.js`: Token Trace
- `chart.js`: area and bar charts

## Rules

- Views build their DOM once and update targeted nodes from `store.subscribe` (batched per animation frame).
- Never put `.empty` or another component class name on a sub-element. Modifier classes are prefixed (`is-empty`).
- No number appears unless it came from the engine.
