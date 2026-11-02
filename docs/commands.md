# cache-watch command reference

Every command, label and setting in cache-watch 1.2.0. For the reasons behind them, see [How it works](how-it-works.md).

## /keepwarm

| Command | Effect |
|---|---|
| `/keepwarm` | Arms the default window for this session: 6 hours, or the `windowMinutes` option. |
| `/keepwarm <window>` | Arms a window of your own. A window is hours, minutes or both: `90m`, `2h`, `2h30m`. |
| `/keepwarm <window> every <gap>` | Arms a window with its own ping gap, at least `1m`. The gap lasts for that window only; the next window goes back to 55 minutes. Short gaps are for testing: `/keepwarm 1h every 1m` shows a ping's cost within a minute. |
| `/keepwarm always` | Keeps every session warm for the default window after each of its turns, until `/keepwarm off`. |
| `/keepwarm status` | Says the time left, the next ping, and what the last ping read and cost. |
| `/keepwarm off` | Ends the window and turns `always` off. |

Pings go out 55 minutes after the last request, the last request being yours or a ping. If the cache is already cold when you arm a window, the first ping waits until after your next turn.

A window ends at its deadline, at `/keepwarm off`, or when a ping fails. A ping counts as failed when it:

- reads nothing from the cache,
- writes a tenth or more of what it read (the cache was already gone),
- hits an API error or is interrupted,
- comes back empty, or finds no conversation to warm.

The reason shows in `/keepwarm status` and on the `/cache-watch` card.

## /cache-watch

| Command | Effect |
|---|---|
| `/cache-watch` | Prints the status card (below). `/cache-watch status` does the same. |
| `/cache-watch pay` | Sends the held message and pays the cold write, as the **Pay and send** button does. |
| `/cache-watch fresh` | Runs `/clear` and puts the held message back in the prompt box, as **Start fresh** does. With no message held and the resume card showing, it only runs `/clear`. |
| `/cache-watch compact` | Compacts, then sends the held message, as **Compact and send** does; with no message held and the resume card up, compacts only. Needs the `coldCompact` option. |
| `/cache-watch close` | Closes the hold card and puts the message back in the prompt box unsent, as **Close** does. |
| `/cache-watch dismiss` | Closes the resume card, as its **Dismiss** button does. |
| `/cache-watch preview` | Shows the hold card with this session's numbers, holding nothing. Any button closes it. A session under 50,000 tokens borrows 400,000. |
| `/cache-watch preview resume` | Shows the resume card. Its buttons only close it: nothing is cleared or compacted. |
| `/cache-watch preview receipt` | Shows the receipt of a paid cold write. Nothing was paid; it goes at your next message. |
| `/cache-watch preview compacted` | Shows the receipt of a send that compacted first. |
| `/cache-watch dry-run` | Says what a message from a phone would meet right now. Sends and compacts nothing. |
| `/cache-watch guard refuse` | Holds a cold send once on the card. This is the default. |
| `/cache-watch guard warn` | Lets cold sends through and shows the price on the receipt pill afterwards. |
| `/cache-watch footer on` | Shows the status in the prompt footer. This is the default. |
| `/cache-watch footer off` | Shows the status as a row above the prompt box instead. |
| `/cache-watch footer` | Says which is set, and whether the footer has drawn yet in this session. |

The `pay`, `compact`, `fresh` and `close` commands do what the buttons do because a click in the desktop app can get lost while any mod redraws ([anthropics/claude-code#99211](https://github.com/anthropics/claude-code/issues/99211)). The first click on the band can also only move focus there. The commands always land.

### The status card

| Line | Shows |
|---|---|
| (first line) | The model the last turn used. |
| `state` | `warm, 54m left`, `COLD, last request 6h12m ago`, `no request yet this session`, or `reset by compaction`. |
| `lifetime` | The cache's lifetime, five minutes or an hour, and what chose it. |
| `context` | The conversation's size in tokens: what a cold send would re-write. |
| `cold cost` | The re-write at the cache-write rate, and a warm turn at the read rate. |
| `keepwarm` | The window's time left and next ping, `stopped` with the reason, or `off`. |
| `break-even` | How many pings cost the same as one cold write at the read rate, and how much idle time that covers at the current gap. |
| `guard` | `refuse once` or `warn only`. |
| `session` | Cold writes paid in this session, and their total. |

## The footer label

| Label | When |
|---|---|
| `cache warm · 2h07m left` | The cache is warm and keepwarm is running. The time is what's left in the window. |
| `cache warm · 54m left` | The cache is warm and keepwarm is off. The time is what's left of the hour. |
| `cache cold for 6m` | The cache has gone cold. Longer spells read `5d 20h`. |
| `cache · keepwarm 6h00m` | Keepwarm is armed but nothing has been sent yet in this session, or the conversation was just compacted. |
| `cache · keepwarm stopped` | Keepwarm stopped before the first turn. |
| (nothing) | No request yet, or just compacted, and keepwarm off. The app's own footer labels show as usual. |

`warm` is green and `cold` is orange, and both words are always there. Every label is 24 characters or fewer, because the desktop footer cuts text at about 26. The label redraws every minute while the cache is warm or keepwarm is running, and every 5 minutes while the cache sits cold with keepwarm off.

The status row above the prompt box, used when the footer is off or hasn't drawn yet, shows the same state with more detail: the cube icon, the next ping and the last ping's cost.

## The hold card

| Part | Shows |
|---|---|
| Header | `CACHE WATCH`, "Your message is on hold", and how long the cache has been cold. |
| Send it now | The re-write price, its token count and the cache-write rate. |
| A warm turn | What the same turn would have cost with the cache warm. |
| On hold | Your message, cut at 160 characters. |
| Buttons | **Pay and send**, **Compact and send** (with the `coldCompact` option), **Start fresh**, **Show cache status**, **Close**. The desktop app draws Close as a cross at the top right. |

When the band above the prompt has fewer rows than the full card needs (24 in the desktop app, 18 in a terminal), the card turns compact: a one-line header and thin bars, with the buttons still in view.

## The resume card

Opening an old chat whose cache Claude Code reports as likely expired, with 50,000 tokens or more of context, shows this card above the prompt box.

| Part | Shows |
|---|---|
| Header | `CACHE WATCH`, "Resuming a cold chat", and how long the cache has been cold. |
| Send it now | What your first message will cost to re-write the cache. This is Claude Code's own estimate when the resume carries one, and the rate shown is worked out from it. |
| A warm turn | What the same turn would cost with the cache warm. |
| Tip | "A cold cache means the AI has to re-read everything in the session all over again. If the juice isn't worth the squeeze, consider starting a fresh chat." |
| Buttons | **Compact** compacts the conversation, with the `coldCompact` option. **Start fresh** runs `/clear`. **Dismiss** closes the card; the desktop app draws it as a cross at the top right. |

The card goes when you send a message, run `/clear`, or press either button. Your first message after it goes straight through, never held, because the card already showed you the price. The same goes for the plain line. Where no band draws, such as the VS Code panel, cache-watch logs a one-line version in the chat instead, 3 seconds after the session resumes.

## The receipt pill

After a paid cold write, a receipt pill above the prompt box says what the write cost and how long keepwarm now holds the cache. After a send that compacted first, it says what the smaller write cost and from what size the conversation was compacted. It goes at your next message, after 15 minutes, or when you press **Dismiss**, a cross at the top right in the desktop app.

## Sharing the band with other mods

The desktop app has one band above the prompt box and gives it one close control, so cards from two mods can't stand there side by side, each with its own cross. On the desktop the hold card takes the whole band, because your message waits on it. The resume card, the receipt pill and the status row give way while a mod listed after cache-watch draws there, such as prompt suggestions, and come back when it goes. A terminal stacks cache-watch's cards under the other mod's.

## Settings and environment

Options live in `/config`, or under `pluginConfigs` in `settings.json`:

| Option | Default | Effect |
|---|---|---|
| `windowMinutes` | `360` | The default window: bare `/keepwarm`, and how long after a turn `always` keeps the cache warm. |
| `always` | off | Same as `/keepwarm always` for every session. `/keepwarm off` stays off until `/keepwarm always`. |
| `cutoffTime` | none | A local time such as `21:30`. Past it no automatic window opens or lasts, until midnight. An explicit `/keepwarm` is not cut. |
| `coldCompact` | off | Adds the Compact buttons, and compacts before a cold send from Remote Control or the Telegram relay. Turn it on only where compaction is cheap on a cold cache, as JetCompact's is: the built-in summary reads the whole conversation uncached. |

The cache's lifetime is Claude Code's, five minutes or an hour, read from its own rules at session start and before each ping. The status card's `lifetime` line says which and why. A five-minute cache gets no pings.

- **Theme.** The colours follow Claude Code's light or dark theme, and change when you switch.
- **`NO_COLOR`.** Set to anything non-empty before the session starts, it drops the colours and the cube image. The words carry the state on their own.

## What it stores

cache-watch keeps these in Claude Code's plugin store, on your machine:

| Key | Holds | Kept until |
|---|---|---|
| `deadline:<session id>` | When this session's keepwarm window ends | The window ends or stops |
| `every:<session id>` | A custom ping gap, only when you set one | The window ends or stops |
| `always` | Whether `/keepwarm always` is on; with the `always` option, also a `false` from `/keepwarm off` | `/keepwarm off`, or for good with the option |
| `queued:<session id>` | Messages dropped for a compaction and not yet sent again | They are sent |
| `guard` | `refuse` or `warn` | You change it |
| `footer` | `on` or `off` | You change it |

A session you never come back to leaves its two keepwarm keys behind, because cache-watch only cleans up the current session's keys. They're a few bytes each.

The held message, the cache clock and the session's cold-write tally live in Claude Code's state for the running session, so they outlive a reload of the mod and go with the process. Nothing else is written anywhere.

## What it can reach

From `claude plugin validate` on Claude Code 2.1.314:

```
hooks: config.set{key=theme}, ui.render{component=AbovePrompt}, ui.render{component=SessionMode}, session.attach, session.start, session.end, classic.SessionStart, command.run{command=keepwarm}, command.run{command=cache-watch}, prompt.submit, turn.step, turn.complete, session.compact, classic.PostModelSwitch
calls: $.clock.after, $.clock.now, $.command.list, $.command.register, $.command.run (via compactNow, freshFromResume, startFresh), $.config.list, $.env.get, $.model.fork (via ping), $.prompt.fill (via closeCard, startFresh), $.prompt.submit (via compactThenSend, payAndSend), $.session.compact (via compactNow), $.session.id, $.session.model, $.session.surfaces (via hasBandSurface), $.session.usage, $.settings.read (via readTtl), $.state.get, $.state.set, $.store.delete (via compactThenSend, endConversation, prune, reseat, startWindow, stop), $.store.get, $.store.set, $.ui.invalidate, $.ui.log, $.ui.resolve, $.ui.status, $.ui.toast (via compactFromResume, freshFromResume, startFresh)
env reads: ANTHROPIC_API_KEY, CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, CLAUDE_CODE_PROMPT_CACHE_TTL, CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_FOUNDRY, CLAUDE_CODE_USE_VERTEX, ENABLE_PROMPT_CACHING_1H, FORCE_PROMPT_CACHING_5M, NO_COLOR
```

In plain words:

- **It reads every prompt you send.** It checks whether a message starts with `/`, whether it carries attachments or an `@file` mention, and, only when holding it or compacting first, keeps the text so it can be sent again. That text is stored while a compaction runs.
- **It reads the settings and environment that set the cache's lifetime.** `ANTHROPIC_API_KEY` and the provider switches count only as set or not: an API key means five minutes. Their values go nowhere.
- **It reads timing and usage.** That's when each request goes out, plus the token counts and model Claude Code already has for each turn and each ping.
- **It sends one kind of request of its own:** the keepwarm ping, with a fixed one-line prompt, only inside a keepwarm window. That's a window you armed, or the 3 hours it arms itself after you pay a cold write.
- **It sends your held message** when you press Pay and send or Compact and send, runs `/clear` when you press Start fresh, and runs `/compact` for the Compact buttons and, with the `coldCompact` option, for a cold message from a remote session.
- **It has no file, network or process access.** `$.fs`, `$.http` and `$.process` aren't in its calls.
