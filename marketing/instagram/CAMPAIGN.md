# First Instagram test: 50 players

**The goal is to learn, not to grow.** We want 50 new people who **start playing**, meaning they open a room or join one, and then we look at where they get stuck. The cost estimates below are rough, so treat the first day's numbers as the real ones.

## 0. Before you start (about 30 minutes, once)

1. **Make 2.6 live.** It recognises Instagram's browser and Instagram ad clicks, and adds the new icon.
2. **Set up an Instagram professional account.** In Instagram go to Settings → Account type and tools → Switch to professional account → Creator (or Business). Only professional accounts can run ads.
3. **Set up the profile:**
   - Picture: `marketing/icon/instagram-profile-1080.png`
   - Name: `דף ועיפרון · 5 משחקים לשניים`
   - Bio: `5 משחקי דף ועיפרון לשניים ✏️ כל אחד בטלפון שלו · בחינם`
   - Link: `https://small-joys.com/?utm_source=instagram&utm_medium=bio&utm_campaign=launch`
4. **Post the ad once as a normal post.** Post `story.mp4` as a Reel and `feed.png` as a post, with the text from `README.md`. An ad from an account with 0 posts looks like spam.
5. **Add a payment method** in Ads Manager (or in Instagram's "Ads payments").

## 1. Choose how to run it

| | **A. Boost from the Instagram app** (recommended for this test) | **B. Meta Ads Manager** |
|---|---|---|
| Setup time | 5 minutes, on your phone | 30 minutes, on a computer |
| Control | Basic | Full: placements, A/B testing, per-ad tracking |
| Fits | A first test of 50 players | The next round, once you know what works |

### A. Boost (in the Instagram app)
1. Open the Reel (`story.mp4`) and press **Boost**.
2. **Goal: More website visits.**
   - Website: `https://small-joys.com/?utm_source=instagram&utm_medium=paid&utm_campaign=launch&utm_content=reel_boost`
   - Button: **Learn more**
3. **Audience → Create your own:**
   - Location: **Israel**
   - Age: **20–45**
   - Interests: *board games, puzzles, mobile games, word games, family*
4. **Budget: ₪60 a day for 4 days** (about ₪240). Meta reviews the ad first, usually within a few hours and at most 24 hours.

### B. Ads Manager (adsmanager.facebook.com)
1. **Campaign:**
   - Objective: **Traffic**
   - Name: `launch-50`
   - Budget: ₪60 a day, campaign budget on
2. **Ad set:**
   - Conversion location: Website
   - Optimise for: **Landing page views**, not link clicks. Clicks include people who leave before the page loads.
   - Audience: Israel, ages 20–45, language Hebrew, the same interests as above
   - Placements: **Manual → Instagram only**, with Stories, Reels and Feed ticked
3. **Ads.** Make 2 ads in the same ad set so Meta can pick the better one:
   - `story_video`: upload `story.mp4`. It's used for Stories and Reels.
   - `feed`: upload `feed.png`.
   - Text, headline and button: copy them from `README.md`.
   - Website URL: `https://small-joys.com/`
   - **URL parameters:** `utm_source=instagram&utm_medium=paid&utm_campaign=launch&utm_content={{ad.name}}`. This fills in each ad's name automatically, so the funnel can compare them.

## 2. Rough numbers (Israel, small budget)

| Step | Estimate | Needed for 50 players |
|---|---|---|
| Cost per landing page view | ₪1.5–3 | |
| Visitors who open or join a room | 30–50% | 100–170 visits |
| **Total** | | **about ₪200–400** |

Hosts invite a friend, and friends who join through an invite cost nothing. They show up in the funnel with `invited_from_source = instagram`.

## 3. Watch it

**Two hours after it starts,** check that the tracking works. Ask Claude "run the Instagram funnel" (`python3 tools/funnel.py 1 instagram`). You should see `$browser = In-app (Instagram)` and players with source `instagram`.

**Every day,** run the funnel and look for the step with the biggest drop:

| If the biggest drop is… | It means | Try |
|---|---|---|
| Few clicks: the ad's CTR (clicks ÷ times shown) is under 0.7% in Ads Manager | The ad doesn't stop the scroll | A different first line; open on the game, not the text |
| Visits, but no rooms opened | The home page doesn't explain or convince | Look at `name_missing` and the last screen; make the button clearer |
| Rooms, but no partner joins | The visitor is alone and doesn't send the invite | This is the big risk. Make the ad say "send it to a friend"; check `invite_shared` |
| Partner joined, but no game finished | The game is hard or confusing | Look at `game_abandoned` by game and phase, and `tutorial_viewed` with `trigger = asked` |
| Connection problems | A technical problem | `connection_problem` by browser; Instagram's built-in browser is the suspect |

**Stop or change** if after ₪100 you have fewer than 10 players: change the ad before spending more.

## 4. After 50 players: what we learn

- **Activation rate:** what share of visitors finish a first game. This is the number to improve.
- **Where the most people stop.** Fix that first, then run the next round with the same ad, so you can tell whether the fix helped.
- **Viral reach:** how many guests each Instagram host brings.
- **Return rate:** did anyone come back within 7 days (PostHog → Retention)?
- **Which ad won:** compare players who finish a game by `utm_content`.
