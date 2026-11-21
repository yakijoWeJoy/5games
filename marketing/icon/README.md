# Icon

| File | Use it for |
|---|---|
| `instagram-profile-1080.png` | the Instagram profile picture (made for Instagram's circle crop) |
| `icon-1024.png` | anywhere a large square icon is needed |
| `/icons/*` | the site's own icons: browser tab, home screen on iPhone and Android, and the preview image when a link is shared on WhatsApp |

To change the icon, edit `icon.html`, then run from the repo root:
```
python3 -m http.server 8765 &   node marketing/icon/render.js
```
