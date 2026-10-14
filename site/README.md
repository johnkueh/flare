# flare.jkyf.dev

The Flare website: one static page in `public/`, served by the `flare-site`
Worker on flare.jkyf.dev.

The pixel art is drawn in code (`scripts/sprites.py` writes `public/art/*.svg`);
edit a sprite's grid there and run `pnpm art`. The style follows heycooked.com:
Bricolage Grotesque headings, orange `#F97316`, and chunky borders with a hard
shadow, on Flare's cream background.

```sh
pnpm install
pnpm dev          # http://localhost:8787
pnpm run deploy   # needs a Cloudflare token for John's account
```
