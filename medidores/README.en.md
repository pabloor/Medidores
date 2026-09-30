# Console meters on your phone

*[Español](README.md) · English*

Shows the meters of a digital mixing console in real time on any phone connected to the same Wi-Fi. With Yamaha consoles it can also control faders, channel ON and preamp gain.

## How it works

A phone browser cannot talk to the console directly (the console uses UDP or raw TCP), so a small program acts as a bridge:

    Console  --UDP/OSC or TCP-->  Computer or Raspberry Pi (server.js)  --WebSocket-->  Phone(s)

The bridge computer also serves the web page, so on the phone you only need to open an address. Several phones can connect at the same time.

## Using it on a Mac (the usual way)

1. Install Node.js once: the LTS version from https://nodejs.org.
2. Double-click **Abrir Medidores.command** ("Open Meters"). The first time it takes a little longer and needs internet access to download what the app uses.
   - If macOS says it cannot open it because it is from an unidentified developer: right-click the file, choose **Open** and confirm. This is only needed the first time.
3. The browser opens on the **Connect to the console** screen. Choose the brand, enter the IP if needed and press **Connect**.
4. A QR code appears: scan it with your phone (on the same Wi-Fi) to open the app there.

The console choice is saved in `config.json`, so next time it connects on its own. To change console, tap the status text at the top or go to Settings → Change console. This works from the phone or from the Mac. The phone-shaped button (at the top, on the Mac only) shows the QR code again. The QR code uses the Mac's Wi-Fi address, which is where the phones connect. As soon as a phone connects, the QR code switches to the address that phone came through, which is the most reliable. If the Mac has several connections (Wi-Fi, cable, VPN…), the QR window lists all its addresses in case another one needs to be tried.

When you update the app, phones with an older version open reload by themselves when they reconnect.

With **Peak hold** enabled, each meter keeps its highest peak until you tap that channel's strip (which also shows its peak in dB) or press the circular-arrow button next to Meters/Control, which clears all peaks and clips. The red clip indicator lights at 0 dB, just like on the DM7 (verified with a test tone). Clearing is shared: it applies at once on all phones and on the Mac. The console's own peak hold is independent: the DM7 does not expose it over the network, so clearing on the console does not clear the app, nor the other way round.

To close the app, close the Terminal window opened by the launcher.

To update the app (by replacing the folder), just double-click **Abrir Medidores** again: if it detects an older version running, it closes it and starts the new one.

The file names of the launchers and tools are in Spanish: **Abrir Medidores** means "Open Meters" and **Diagnóstico Yamaha** means "Yamaha Diagnostics".

## Using it from the Terminal (optional)

    npm install
    node server.js                                   # opens the connection screen
    node server.js --driver yamaha --ip 192.168.1.20 # connects directly
    node server.js --driver sim                      # simulator
    node server.js --port 8080                       # different port

## Show log and full-screen view

- **Clip log:** every time a channel reaches 0 dB, it is logged with its name, time and peak, and a brief notice appears on every phone. Consecutive clips on the same channel (less than 3 seconds apart) count as one. The chart button at the top opens the log and shows how many clips you have not seen yet.
- **Level history:** in the same window, a second-by-second chart for up to 12 hours. The Mac keeps every channel, so you can look at any of them afterwards. With **Choose channels** you pick which ones to show, up to 6 at a time, each in its own colour; the main output is shown by default. With one channel you see its peak and average; with several, the peak of each. Tapping the chart shows the values at that moment. The checkbox above the clip list shows only clips from the chosen channels. It is the console's digital level (dBFS), not the sound pressure level in the room.
- **Download:** the log and the history (of the chosen channels) can be downloaded as CSV. The Mac keeps them, so they are the same on every phone; they are cleared when changing console or closing the app.
- **Moving the log:** on a computer, the log window is a floating panel that you drag by its title and that lets you keep using the meters behind it; it remembers its position. **Open in a separate window** opens it as an independent browser window that you can move to another screen, enlarge or make full screen. On phones it opens as usual.
- **Full-screen view:** in Meters mode, press and hold a channel to see it full screen, with its level in large figures and its peak. If the channel is linked (the console's link group or stereo pair), all channels in the group are shown: stacked in portrait or side by side in landscape. Tap to close.

## Messages and line check (FOH and stage)

These two features are shared with the stage version (read-only). This app acts as the hub: stage phones link to it through port 3000 on the same computer. The link only carries messages and line check: it gives no access to this app's meters nor to any console control.

- **Messages:** the speech-bubble button at the top opens messages. There are quick messages ("Ready", "Change the battery", "Check the cable", "No signal"…), which each phone shows in its own language, and free text, and a channel can be attached. Incoming messages are shown in large type, below the top bar, until you press **Seen**; the sender sees who has read them. On Android the phone vibrates; on iPhone, Safari does not allow it. In Settings you can enter your name.
- **Line check:** in Settings → Line check. Press **Start** and give signal to each mic or line: each input channel is ticked automatically when it receives a clear signal (above −40 dB for a moment), with its peak. Channels with a low level (between −80 and −45 dB) that stays almost constant for 5 seconds are flagged as possible noise or hum. Every phone, FOH and stage, sees the same line check live. When finished, it shows which channels gave no signal. Tapping a channel opens a message about it.

## Language

The app is available in Spanish, English, Chinese and Russian. Each phone uses the phone's language by default (or English if it is none of the four), and it can be changed in Settings → Language or on the connection screen. Translations are in `public/i18n.js`.

## Supported consoles

| Driver | Models | Connection | Reliability |
|---|---|---|---|
| `x32` | Behringer X32, Midas M32 | UDP 10023, found automatically | Well-documented protocol |
| `xair` | Behringer XR12/16/18, Midas MR12/18 | UDP 10024, found automatically | Well-documented protocol |
| `yamaha` | TF1/3/5, TF-Rack, DM3, DM7, CL1/3/5, QL1/5, Rivage PM | TCP 49280, IP required | Official Yamaha protocol, community details |
| `digico` | SD, Quantum, S21/S31 | UDP, IP required | **Experimental** |

**Test status:** the Yamaha driver is verified on a real console (DM7 Compact, firmware V1.73): meters, faders, ON, gains, links and stereo pairs. The others have only been tested with emulators. To check the channel map: Settings → "Show raw values", send signal into a specific channel and see which index moves.

### Behringer / Midas

`npm start` finds them automatically. If the console does not appear, use `node server.js --ip 192.168.1.20`. If something does not match, it is fixed in `drivers/behringer.js` (the `start` and `count` fields of each group). On the XR12/XR16 the number of channels may differ.

### Yamaha

    node server.js --driver yamaha --ip 192.168.1.20

The console IP is shown on its network settings screen. The driver asks for the model, requests the meters of each group and shows only those the console accepts. The number of channels comes from the data the console sends.

- **TF, DM3 and DM7:** channels, returns, Mix, Matrix and Stereo. By default, channels are metered before the HPF (Pre HPF) and outputs after the fader (Post ON). The channel metering point can be changed in Settings → Input channel metering point (Pre HPF, Pre fader or Post ON). It is saved in `prefs.json` and applies to all phones.
- **CL/QL and Rivage PM:** according to community documentation, only Mix and Matrix meters are available through this protocol. The driver also tries to request the channels and hides them if the console rejects them.
- The DM7 uses a different meter scale. The conversion table (`drivers/yamaha-dm7-meter.json`) comes from the Bitfocus Companion yamaha-rcp module, under the MIT licence.

### Console control (Yamaha only)

With a Yamaha console connected, the **Meters / Control** selector appears at the top. In Control, each channel has its meter, preamp gain, ON button and fader to the Stereo bus, with a dB scale next to the fader (from +10 to −∞, with 0 highlighted) and its exact value below. If the fader is short, the scale only shows the marks that fit. The Stereo faders stay pinned on the right: A and B on the DM7, a single one on the others.

**Layers:** at the bottom, in Control mode, choose what to show:

- **Channels, Mix and Matrices:** Mix buses and matrices have fader, ON and meter, with no gain since they have no preamp. Verified that the DM7C exposes fader and ON for its 48 Mix buses and 12 matrices over the network.
- **Custom:** your own layer. With the pencil you pick the strips you want, from any group (channels, Mix, matrices or Stereo), in the order you tap them. Each strip shows its group colour at the top.
- **Stereo A/B:** the button on the right hides or shows the Stereo faders, to save space. If you put a Stereo in the Custom layer, it appears there instead of on the right.

The chosen layer, the Custom layer and whether the Stereo is shown are saved on each phone.

Safety measures:

- **Control starts locked.** Tap the padlock to unlock it. By default it locks again after 2 minutes without use (Settings → Auto-lock).
- **Faders move by dragging, not by tapping.** Movement is relative, so a fader never jumps to where you put your finger. There is a detent at 0 dB, and swiping horizontally scrolls the list without moving any fader.
- **Fader limit:** 0 dB by default (Settings → Fader limit). If a fader was already higher on the console, it can be lowered but not raised further.
- **Gain in 1 dB steps.** Holding + or − repeats the step.

Console and app stay in sync both ways: whatever is changed on the console appears in the app, and whatever is changed on one phone appears on the others.

What can be controlled on each model:

| Model | Fader and ON | Preamp gain |
|---|---|---|
| DM7 | Yes | Yes, −6 to +66 dB |
| DM3 | Yes | Yes, 0 to +64 dB |
| CL / QL / Rivage | Yes | Yes, −6 to +66 dB |
| TF | Yes | Not documented: not shown |

Notes:

- On the DM7, CL, QL and Rivage, **gain belongs to the input port, not to the channel.** If that preamp is used by other channels, or by a stagebox shared with another console (for example, the monitor console), the change affects all of them.
- If the channel is not patched to a preamp with adjustable gain (for example, a digital input), "—" is shown.
- **Linked channels (link and stereo):** the app reads the console's link groups. If a group links the gain, changing it on one channel applies the same change in dB to the rest of the group, keeping their differences, just as the console does. The console itself propagates fader and ON on linked channels. Links are re-read every 5 seconds, so changes made on the console are picked up without reconnecting. Each linked strip shows its group (for example, L12). Channels paired in stereo (the console's InCh/Role parameter) are also respected and carry the ST tag. Verified on a DM7C V1.73; it may not be available on other models.
- The DM7 reports gain in whole dB on some channels and in hundredths of a dB on others, depending on the preamp. The app detects the unit of each channel and always shows whole dB.
- For now, only mono input channels and the Stereo bus are controlled. The stereo inputs of the TF and DM3 and the Mix buses are not included.
- The Dante Rx Gain and the digital gain are not available: the DM7C (V1.73) does not expose them through its network protocol.
- Control is verified on a DM7 Compact. On other models, test it first with the console and no audience.

### Shure wireless receivers

On console channels without a preamp (for example, those arriving over Dante from a wireless receiver), the app can control the gain of the receiver itself. It works with Shure Axient Digital receivers (AD4D, AD4Q), and the same command exists on ULX-D, QLX-D and SLX-D.

1. In the app: Settings → Shure receivers. Enter the receiver IP and indicate which console channel each receiver channel goes to (for example, 1 → 25 and 2 → 26). Press **Add receiver**.
2. On those channels, the gain appears with the **SHURE** tag and is adjusted with − and +, from −18 to +42 dB in 1 dB steps.

Details:

- **Only applies to channels without HA.** If the channel has a preamp, the app shows and controls the console's HA gain and does not allow a receiver to be assigned to it.
- **Sync:** the receiver reports changes made on its front panel or in Wireless Workbench, so the app always shows the real value.
- **Offline:** if there is no connection to the receiver, "—" is shown along with a red dot in Settings. The app reconnects on its own.
- **Network:** the bridge computer must be able to reach the receiver's IP. If the receiver is on a different network from the console router, connect the Mac to both networks (Wi-Fi to the console router, cable to the receiver network), making sure the two networks use different IP ranges.
- **Configuration:** saved in `shure.json` in the app folder.
- **Protocol:** the one published by Shure (TCP, port 2202). The integration has been tested with an emulator only.

### DiGiCo (experimental)

DiGiCo does not provide meters over its general OSC. This driver uses the protocol of its iPad app, which the community has only partly decoded. There are three important limitations:

- **The console only accepts one iPad-type device at a time.** If the engineer is using DiGiCo's official iPad app, this app cannot connect, and vice versa.
- The value scale is not confirmed. With `--digico-scale` you can try `linear`, `db` or `pos` (default: `auto`).
- For now it only shows input channels.

Console setup:

1. Setup → External Control → enable External Control.
2. Add a **DiGiCo Pad** device with the bridge computer's IP. Set Send to port 9000 and Receive to port 8000.
3. Load the iPad command set on the console. Without it, the console does not respond and gives no error.

Start:

    node server.js --driver digico --ip 192.168.1.20 --sniff

If you used other ports on the console, add `--send-port` and `--listen-port`. With `--sniff`, the Terminal shows every new message the console sends. If it does not work the first time, copy that output: it helps adapt the driver to your model.

## Testing without a console

- `npm run sim`: simulated console with concert-like levels.
- Emulators of the real network protocols, to test each driver. Start one in one terminal and the server in another:
  - `node tools/mesa-falsa.js` (or `--xair`) → `node server.js --ip 127.0.0.1`
  - `node tools/yamaha-falsa.js --modelo DM7` (or `TF5`, `CL5`) → connect to Yamaha at IP 127.0.0.1. It accepts control and every 6 s moves the channel 1 fader, as if someone touched it on the console.
  - `node tools/shure-falsa.js` → in Settings, add receiver 127.0.0.1 with channel 1 → 25 and channel 2 → 26 (the fake Yamaha has no HA on those channels). Every 8 s it changes the gain of channel 2, as if someone touched it on the receiver.
  - `node tools/digico-falsa.js` → `node server.js --driver digico --ip 127.0.0.1`

The emulators' console messages are in Spanish (*mesa falsa* = fake console).

## Troubleshooting

- **The console is not found:** check that the bridge computer is on the same network as the console. Try `--ip`. Some routers block broadcast messages.
- **The console is found but no meters arrive:** the computer's firewall may block incoming UDP. On Windows, allow Node.js on private networks.
- **The phone does not open the page:** many guest networks use "client isolation" and do not let devices see each other. Use the main network or the console router's own Wi-Fi.
- **XR18/MR18 in access point mode:** connect the bridge computer and the phone to the console's own Wi-Fi.
- **The screen turns off:** the page can only keep the screen awake over https; adjust the phone's screen timeout instead.

## Yamaha console diagnostics

**Diagnóstico Yamaha.command** (or `node tools/volcar-parametros.js IP`) asks the console for the list of all its parameters, the current link values, the values of every input channel parameter, and tests a set of undeclared gain addresses. It saves everything to `parametros-<model>.txt`. It is read-only and is used to adapt the app to a new model or a new firmware. Its messages are in Spanish.

## Adding more brands

Each brand is a file in `drivers/` that emits these events:

- `status` → `{ state: 'searching'|'connecting'|'connected'|'lost'|'error', detail, key, p }`. `detail` is the Spanish text; `key` and `p` are the message code and its data, so that each phone shows it in its own language (see `public/i18n.js`)
- `layout` → `{ mixer: { name, model, ip }, groups: [{ id, name, strips: [{ num, name }] }] }` (the group with `id: 'main'` is pinned on the right)
- `levels` → one array per group with the levels in dBFS (-90 = silence)
- `raw` → optional, unprocessed values for debugging

It is then registered in `drivers/index.js`.

Already done: Yamaha and DiGiCo (above). Candidates, based on what is known about their protocols:

- **Behringer Wing:** its own documented protocol with meters; more complex than the X32's.
- **Soundcraft Ui12/16/24:** use WebSocket; the community has decoded the protocol, including the VU meters.
- **PreSonus StudioLive Series III:** UCNet protocol decoded by the community, with meters.
- **Allen & Heath, Midas Pro/HD96, Mackie DL:** still to be investigated. Their public protocols are usually designed for control (faders, mutes) and often do not include meters.
