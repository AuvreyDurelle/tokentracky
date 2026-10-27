// Repo-native artwork. Fixed canvas, colors, fonts and coordinates; no external assets.
import AppKit

let size = NSSize(width: 660, height: 440)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 660, pixelsHigh: 440,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(srgbRed: 0.055, green: 0.075, blue: 0.10, alpha: 1).setFill()
NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ fontSize: CGFloat, _ color: NSColor, bold: Bool = false) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
        .font: NSFont(name: bold ? "Helvetica-Bold" : "Helvetica", size: fontSize)!, .foregroundColor: color,
    ])
}
let mint = NSColor(srgbRed: 0.42, green: 0.94, blue: 0.76, alpha: 1)
text("TOKENTRACKY", 40, 380, 15, mint, bold: true)
text("Waste tokens, not time.", 40, 328, 34, .white, bold: true)
text("Drag Tokentracky into Applications", 40, 65, 19, .white)
text("Private by default. Built for the way you code.", 40, 42, 12, .lightGray)
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 302, y: 196)); arrow.line(to: NSPoint(x: 357, y: 196))
arrow.move(to: NSPoint(x: 345, y: 207)); arrow.line(to: NSPoint(x: 357, y: 196)); arrow.line(to: NSPoint(x: 345, y: 185))
arrow.lineWidth = 3; mint.setStroke(); arrow.stroke()
NSGraphicsContext.restoreGraphicsState()
let data = bitmap.representation(using: .png, properties: [:])!
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
