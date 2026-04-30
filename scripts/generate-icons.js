/**
 * Generate PWA icons for PACE RISE : Node
 * Uses Audiowide-style text: "P-R :" and "Node"
 * White background, dark gray text
 */
const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

const ICON_DIR = path.join(__dirname, '..', 'public', 'icons');
if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

// Try to register Audiowide font if available
const fontPath = path.join(__dirname, 'Audiowide-Regular.ttf');
let fontFamily = 'sans-serif';
try {
    if (fs.existsSync(fontPath)) {
        registerFont(fontPath, { family: 'Audiowide' });
        fontFamily = 'Audiowide';
    }
} catch(e) {}

function generateIcon(size, filename) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // White background with subtle border
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    // Scale factor
    const s = size / 512;

    // Draw text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Line 1: "P-R :"
    const fontSize1 = Math.round(120 * s);
    ctx.font = `${fontSize1}px ${fontFamily}`;
    ctx.fillStyle = '#333333';
    // "P-R" in dark, ":" in green
    const line1Parts = [
        { text: 'P-R ', color: '#333333' },
        { text: ':', color: '#2d9d78' },
    ];
    let x1 = size / 2;
    let y1 = size * 0.36;
    
    // Measure full line
    const fullLine1 = 'P-R :';
    const line1Width = ctx.measureText(fullLine1).width;
    let xCursor = x1 - line1Width / 2;
    
    for (const part of line1Parts) {
        ctx.fillStyle = part.color;
        ctx.textAlign = 'left';
        ctx.fillText(part.text, xCursor, y1);
        xCursor += ctx.measureText(part.text).width;
    }

    // Line 2: "Node"
    const fontSize2 = Math.round(130 * s);
    ctx.font = `${fontSize2}px ${fontFamily}`;
    ctx.fillStyle = '#3b7dd8';
    ctx.textAlign = 'center';
    ctx.fillText('Node', size / 2, size * 0.66);

    // Save
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(path.join(ICON_DIR, filename), buffer);
    console.log(`Generated: ${filename} (${size}x${size})`);
}

// Generate multiple sizes
const sizes = [
    [16, 'favicon-16.png'],
    [32, 'favicon-32.png'],
    [48, 'favicon-48.png'],
    [72, 'icon-72.png'],
    [96, 'icon-96.png'],
    [128, 'icon-128.png'],
    [144, 'icon-144.png'],
    [152, 'icon-152.png'],
    [192, 'icon-192.png'],
    [384, 'icon-384.png'],
    [512, 'icon-512.png'],
];

for (const [size, name] of sizes) {
    generateIcon(size, name);
}

// Also generate favicon.ico as a 48px PNG (browsers handle it fine)
fs.copyFileSync(
    path.join(ICON_DIR, 'favicon-48.png'),
    path.join(ICON_DIR, '..', 'favicon.ico')
);
console.log('Copied favicon.ico');

console.log('\nAll icons generated successfully!');
