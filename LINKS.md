# Links

Links that open your app on the right screen, and still get there when the
app has to be installed first. The app's own Worker serves everything: no
Branch, no AppsFlyer, no Firebase Dynamic Links.

```
tap https://example.com/j/7KQ2M9XD
  ├─ app installed ─────────────▶ the app opens on the invite (Universal Links / App Links)
  └─ not installed ─▶ landing page ("Mia invited you to Flat")
        ├─ Android: Get ─▶ Play (referrer=flare_link=…) ─▶ first launch: claimDeferred() ─▶ the invite
        └─ iPhone:  Get copies the link ─▶ App Store / TestFlight ─▶ first launch: PasteLinkButton ─▶ the invite
```

On Android the link survives the install with no tap: Google Play hands it
to the app through the Install Referrer API. iPhone has no equivalent, so
the landing page copies the link and the app's first screen shows Apple's
paste button. One tap, and no "Allow Paste?" alert. Flare doesn't match
people by IP address and device the way Branch does: on iPhone that's a
guess (iCloud Private Relay hides the IP), and Apple discourages it.

## links.json

One file, next to `flags.json` and `notifications.json`, that the Worker and
both apps read:

```json
{
  "$schema": "node_modules/@flare/links/schema.json",
  "domain": "example.com",
  "name": "Groceries",
  "scheme": "groceries",
  "ios": {
    "appIds": ["ABCDE12345.com.example.groceries"],
    "store": "https://apps.apple.com/app/id1234567890"
  },
  "android": {
    "packages": ["com.example.groceries", "com.example.groceries.dev"],
    "sha256": ["<Play app signing SHA-256>", "<debug SHA-256>"]
  },
  "links": {
    "invite": { "path": "/j/:code", "deferred": true },
    "recipe": { "path": "/r/:id" }
  }
}
```

- `links`: each kind of link and its path. Each `:name` is one path segment.
  `deferred: true` carries that kind through an install.
- `scheme`: the app's custom URL scheme. The landing page's Open button
  uses `<scheme>://link?url=…`, because a link tapped on its own domain, or
  inside Instagram's or TikTok's browser, doesn't open the app by itself.
- `ios.store`: an App Store page (a custom product page is fine) or a
  TestFlight link. `appStoreId` adds Safari's Smart App Banner.
- `android.sha256`: the Play app signing key (Play Console → Test and
  release → App integrity) for builds installed from Play, plus any debug
  key. With colons or without.

## The Worker

```sh
pnpm add "@flare/links@github:johnkueh/flare#0.6.0&path:/links"
```

```ts
import { flareLinks } from "@flare/links";
import linksFile from "../links.json";

export default {
  async fetch(request, env) {
    // Before anything that redirects: Apple and Google don't follow redirects.
    const links = flareLinks(linksFile, {
      // What the page and chat previews say. null for the default, false for 404.
      describe: async (link) => {
        if (link.kind !== "invite") return null;
        const invite = await previewInvite(env, link.params.code);
        return invite ? { title: `Join ${invite.name}`, text: "3 people, 42 recipes", detail: link.params.code } : false;
      },
      page: { icon: "/icon.png", accent: "#c2410c", image: "https://example.com/og.png" },
    });
    const res = await links.http(request);
    if (res) return res;
    // …the rest of the Worker
  },
};
```

`links.http` answers `/.well-known/apple-app-site-association`,
`/.well-known/assetlinks.json` and every link path, and returns null for
anything else. The landing page is plain HTML with Open Graph tags, light
and dark. `page.css` adds to its styles. `links.url("invite", { code })`
makes a link on the server.

## iOS

`FlareLinks` and `PasteLinkButton` are in `SyncClient`. Add `links.json` to
the app target, the Associated Domains capability with
`applinks:example.com`, and the URL scheme if the app doesn't register it
already. `npx flare-links setup` prints both.

```swift
let links = FlareLinks(config: try .bundled(), onEvent: { name, params in telemetry.track(name, params) })

WindowGroup { RootView() }
    .onOpenURL { url in
        if let link = links.opened(url) { router.open(link) }   // https and groceries://link
    }

// The first screen, for someone who tapped a link before installing:
if links.mayHavePendingLink {
    PasteLinkButton(links) { link in router.open(link) }
}

// Sharing:
ShareLink(item: links.url("invite", ["code": space.code]))
```

- `mayHavePendingLink` stays true until a link is claimed, a link opens
  the app, or you call `settle()` (say, when onboarding finishes).
- `link(for:)` and `link(in:)` read a URL or pasted text without side
  effects; `opened(_:)` and `claim(_:)` also report `link_opened` and
  `link_deferred_claimed` through `onEvent`.
- While testing, `applinks:example.com?mode=developer` makes devices in
  Developer Mode fetch the file from your domain instead of Apple's CDN,
  which can lag a day behind.

## Android

`FlareLinks` is in `com.johnkueh.sync.client`. Put `links.json` in
`assets/`, add `implementation("com.android.installreferrer:installreferrer:2.2")`
and the intent filters (`npx flare-links setup` prints them):

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="example.com" />
    <data android:pathPattern="/j/.*" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="groceries" android:host="link" />
</intent-filter>
```

```kotlin
val links = FlareLinks(context, context.assets.open("links.json").reader().readText(),
                       onEvent = { name, params -> telemetry.track(name, params) })

// onCreate and onNewIntent
links.opened(intent)?.let(router::open)

// First launch: the link from before the install, if Play has one
scope.launch { links.claimDeferred()?.let(router::open) }

// Sharing
links.url("invite", mapOf("code" to space.code))
```

`claimDeferred()` asks Play once and returns null after that, or when the
app wasn't installed from Play. `claim(pastedText)` reads a pasted link.

## Check it

```sh
npx flare-links check          # reads ./links.json
```

It fetches both files from the live domain (and www), compares them with
`links.json`, checks Apple's CDN copy and Google's Digital Asset Links API,
and loads a sample link's landing page. `npx flare-links url invite code=AB`
prints a link.

## Gotchas

- A Universal Link doesn't open the app when it's typed into Safari or
  tapped on a page of the same domain. That's what the Open button is for.
- Apple reads the association file when the app is installed or updated,
  through its CDN. After changing paths, reinstall to test.
- Android verifies App Links against the certificate that signed the
  installed app. Builds from Play are signed with the Play app signing
  key, not your upload key.
- Adding the associated domain or intent filter is a native change, so it
  ships with the next store build. The Worker side can go out first.
