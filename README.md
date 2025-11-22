# Eye of the Beholder

A real-time facial expression editing interface powered by ComfyUI.

https://youtube.com/shorts/bK8M1iFbdes?feature=share

## Description
This web application allows you to upload an image and manipulate facial features (like wink, smile, head rotation) using an intuitive UI. It communicates with a local ComfyUI instance to generate results.

## Prerequisites
- Node.js installed
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally on `http://127.0.0.1:8188`
- [ComfyUI-AdvancedLivePortrait](https://github.com/PowerHouseMan/ComfyUI-AdvancedLivePortrait) nodes installed in ComfyUI

## Setup & Run

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   node server.js
   ```

3. Open your browser at `http://localhost:3000`.

## Usage
1. Upload a source image.
2. Use the sliders or quick action buttons (WINK, KISS, SMILE, WOW) to change expressions.
3. Drag the white circle on the screen to control the gaze direction.
