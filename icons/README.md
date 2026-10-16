# House icons

The icons our apps and sites use most, drawn once in one style: a 24px grid with a 2px safe margin, 1.5px round strokes, and an outline and a fill variant of every icon. 116 icons, 232 glyphs.

They are our own drawings. The look takes its cues from premium sets like Nucleo (one grid, one stroke weight, a matched fill for every outline), but no shapes are copied from any icon library.

## Which icons, and why

`usage/survey.py` scans our repos for every icon reference (SF Symbols, Material, Lucide, Hugeicons, Phosphor, Tabler, Heroicons, Expo vector icons). `usage/concepts.py` folds each library's name into one concept (`xmark`, `X`, `Cancel01Icon` and `Icons.Default.Close` are all `close`), and `usage/rank.py` ranks the concepts by how many apps use them, then by how often. `usage/ranked.json` is the result from 16 October 2026 across Cooked (heycooked plus the archived recipes.im), GLP3 (Expo, native and the site), Snuglog, reelschat, LedgerSignal, popkr, untrappable, SwingCam, subs.rip, Flare and agent-skills.

Every concept used by two or more apps is in the set, plus a few general basics used by one (users, eye, lock, bookmark, tag, folder and so on) and the food and health icons Cooked and GLP3 lean on.

## Use it

**Web (React)**: copy `react/index.tsx` into the app, or import it from a checkout.

```tsx
import { TrashIcon, HeartIcon } from './icons';

<TrashIcon />
<HeartIcon variant="fill" size={20} className="text-red-500" />
```

Icons take `currentColor`, so they follow the text colour. Pass `title` to give one an accessible name; without it the icon is hidden from screen readers.

**React Native**: same API from `react-native/index.tsx`, on `react-native-svg`. Pass `color` to tint.

**iOS / macOS**: add the `HouseIcons` product from this package.

```swift
import HouseIcons

HouseIcon.close.image()
HouseIcon.heart.image(.fill).foregroundStyle(.red)
HouseIcon.trash.uiImage()   // UIKit
```

The asset catalog keeps the vectors and marks them as templates, so they scale cleanly and take the foreground colour.

**Android**: the drawables ship in the Kotlin library (`com.github.johnkueh:flare`), as `R.drawable.house_<name>` and `R.drawable.house_<name>_fill`.

```kotlin
Icon(painterResource(R.drawable.house_trash), contentDescription = "Delete")
```

**Anything else**: plain SVGs in `svg/outline` and `svg/fill`, and every path in `icons.json`.

`preview.html` is the browsable sheet with usage numbers for each icon.

## Add or change an icon

1. Edit `source/icons.py`. Each icon lists its outline layers (`o`) and, when the fill variant differs, its fill layers (`f`). The layer ops are documented at the top of the file.
2. If it's new, put its name in a group in `GROUPS` at the bottom of the same file.
3. Build: `python3 -m pip install skia-pathops picosvg` once, then `python3 icons/source/build.py`.
4. Open `icons/preview.html` and check it at 16 and 24px next to its neighbours.

The build turns strokes into filled outlines and applies the knockouts, so every output is a single filled path. That keeps the web, iOS and Android versions identical. Everything under `svg/`, `react/`, `react-native/`, `swift/Sources/HouseIcons/` and `kotlin/src/main/res/drawable/house_*` is generated; edit the source instead.

Drawing rules: keep shapes inside 2 to 22 on both axes, use 1.5px strokes with round caps and joins, round box corners at 2 to 2.5, and draw circles as `r=9` around the centre so they match the circled icons.
