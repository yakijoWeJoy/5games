# Instagram campaign: "יאללה, כל היום בסטורי?"

| File | Use it for | Size |
|---|---|---|
| `story.mp4` | Story / Reels ad (animated, 8 s) | 1080×1920 |
| `story.png` | Story ad (still) | 1080×1920 |
| `feed.png` | Feed ad | 1080×1350 (4:5) |

The Story versions keep the top 250 px and the bottom 340 px empty, because Instagram puts its own bar and its link button there.

To change the copy or the screens, edit `ad.html`. The phone screens are real game screens taken from the demo mode, and are stored in `src/`. To render again, run from the repo root:
```
python3 -m http.server 8765 &   node marketing/instagram/render.js
```

## Text for Ads Manager

**Primary text:**
```
יאללה, כל היום בסטורי? 📱
לא חבל – זמן איכות עם חבר/ה ✏️
מקליקים, מזמינים חבר/ה, ויש לכם אחלה זמן כיפי.
5 משחקי דף ועיפרון שאפשר לשחק שוב ושוב – בחינם, בלי הרשמה.
```
**Headline:** `5 משחקים לשניים – בחינם`
**Button:** `Play game` (or `Learn more`)

## Links (one `utm_content` per creative)

```
Story video: https://small-joys.com/?utm_source=instagram&utm_medium=paid&utm_campaign=launch&utm_content=story_video
Story still: https://small-joys.com/?utm_source=instagram&utm_medium=paid&utm_campaign=launch&utm_content=story_still
Feed:        https://small-joys.com/?utm_source=instagram&utm_medium=paid&utm_campaign=launch&utm_content=feed
Profile bio: https://small-joys.com/?utm_source=instagram&utm_medium=bio&utm_campaign=launch
```

The analytics recognise Instagram's built-in browser (`In-app (Instagram)`) and Meta's `fbclid` click ID. Only the fact that the visit came from a click is kept, not the ID.

To see the results:
```
python3 tools/funnel.py 7 instagram
```
