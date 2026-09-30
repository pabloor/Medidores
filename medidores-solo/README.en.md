# Console meters on your phone (read-only)

*[Español](README.md) · English*

Shows the meters of a digital mixing console in real time on any phone connected to the same Wi-Fi.

**This is the stage version (read-only):** it includes no console control at all. It cannot move faders, change gains or switch channels off: the control code has been removed, not just hidden. It is suitable for sharing with other people with no risk to the mix.

## How it works

A phone browser cannot talk to the console directly, so a small program acts as a bridge:

    Console  --UDP/OSC or TCP-->  Computer or Raspberry Pi (server.js)  --WebSocket-->  Phone(s)

The bridge computer also serves the web page, so on the phone you only need to open an address. Several phones can connect at the same time.

## Using it on a Mac

1. Install Node.js once: the LTS version from https://nodejs.org.
2. Double-click **Abrir Medidores.command** ("Open Meters"). The first time it takes a little longer and needs internet access.
   - If macOS says it cannot open it because it is from an unidentified developer: right-click the file, **Open**, and confirm. Only the first time.
3. On the **Connect to the console** screen, choose the brand, enter the IP if needed and press **Connect**.
4. Scan the QR code with your phone (on the same Wi-Fi). The QR code uses the Mac's Wi-Fi address. If the phone cannot open the page, the QR window lists other addresses of the Mac to try.

This version uses **port 3001**, so it can run on the same Mac at the same time as the full version (port 3000).

The console choice is saved in `config.json`. To change it, tap the status text at the top or go to Settings → Change console. To close the app, close the Terminal window. To update it, replace the folder and double-click **Abrir Medidores** again; phones reload by themselves.

From the Terminal (optional):

    npm install
    node server.js                                   # opens the connection screen
    node server.js --driver yamaha --ip 192.168.1.20 # connects directly
    node server.js --driver sim                      # simulator

## Features

- **Meters** for channels, buses, matrices and main outputs, depending on the console. Groups can be hidden with the buttons at the bottom.
- **Input channel metering point** (Yamaha): Pre HPF, Pre fader or Post ON, in Settings. Applies to all phones.
- **Peak hold:** when enabled, each meter keeps its highest peak. Tapping a channel strip clears its peak and shows its value in dB; the circular-arrow button at the top clears them all. Clearing applies at once on all phones.
- **Clip:** the red indicator lights at 0 dB.
- **Language:** Spanish, English, Chinese and Russian (Settings → Language).
- **Outdoor mode:** light background for reading in sunlight.

## Messages and line check (with the FOH app)

If the FOH version (the full one) is open on the same computer, this app links to it automatically:

- **Messages:** the speech-bubble button at the top opens messages. There are quick messages ("Ready", "Change the battery", "Check the cable", "No signal"…) and free text, and a channel can be attached. Incoming messages are shown in large type until you press **Seen**, and the sender sees that they have been read. On Android the phone vibrates; on iPhone, Safari does not allow it. In Settings you can enter your name so it appears on your messages.
- **Line check:** in Settings → Line check. Press **Start** and give signal to each mic or line: each channel is ticked automatically when it receives a clear signal, and channels with a low, constant level are flagged as possible noise or hum. FOH and stage see the same line check at the same time. Tapping a channel sends a message about it.

The link only carries messages and line check: it does not allow any console control. If the FOH app runs on another computer, enter its address in Settings → FOH app address (for example, `192.168.0.34:3000`). Without the FOH app, the meters work as usual; only messages and line check are missing.

## Supported consoles

| Driver | Models | Connection |
|---|---|---|
| `x32` | Behringer X32, Midas M32 | UDP 10023, found automatically |
| `xair` | Behringer XR12/16/18, Midas MR12/18 | UDP 10024, found automatically |
| `yamaha` | TF, DM3, DM7, CL, QL, Rivage PM | TCP 49280, IP required |
| `digico` | SD, Quantum, S21/S31 | UDP, IP required (**experimental**) |

Yamaha is verified on a DM7 Compact (V1.73). The others have only been tested with emulators. On DiGiCo, the console only accepts one iPad-type device at a time: if the engineer is using the official app, this one cannot connect.

## Troubleshooting

- **The console is not found:** check that the computer is on the same network as the console. Try entering the IP.
- **No meters arrive:** the computer's firewall may block the connection. On macOS, accept when asked whether node may receive connections.
- **The phone does not open the page:** guest networks usually prevent devices from seeing each other. Use the main network.

## Testing without a console

- `npm run sim`: simulated console.
- `node tools/yamaha-falsa.js --modelo DM7` and connect to Yamaha at IP 127.0.0.1 (also `tools/mesa-falsa.js` and `tools/digico-falsa.js`). The emulators' messages are in Spanish.
