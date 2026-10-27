//! Where the menu bar popover opens: under the tray icon, inside the screen. Pure, so the tests need no menu bar.

/// A rectangle in logical points, from the top left of the desktop with y downward, as windows are placed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        (self.x..self.x + self.width).contains(&x) && (self.y..self.y + self.height).contains(&y)
    }
    /// This rectangle, in pixels at `scale`, in points.
    pub fn points(self, scale: f64) -> Rect {
        Rect {
            x: self.x / scale,
            y: self.y / scale,
            width: self.width / scale,
            height: self.height / scale,
        }
    }
}

/// A display as Tauri reports it: its frame and visible frame (without the menu bar and Dock) in pixels at its own
/// `scale`. Pixels of displays at different scales are not one space (the frames can overlap), points are.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub frame: Rect,
    pub visible: Rect,
    pub scale: f64,
}

/// The screen that holds the centre of the `tray` icon (in points), else the first, the primary display.
pub fn tray_screen(tray: Rect, screens: &[Screen]) -> Option<&Screen> {
    let (x, y) = (tray.x + tray.width / 2.0, tray.y + tray.height / 2.0);
    screens
        .iter()
        .find(|screen| screen.frame.points(screen.scale).contains(x, y))
        .or(screens.first())
}

/// Space between the popover and the menu bar.
const GAP: f64 = 6.0;
/// The least space between the popover and either side of the screen.
const MARGIN: f64 = 8.0;

/// The top left of a popover of `size` (width, height): centred under the `tray` icon, `GAP` below it, and moved
/// along to stay `MARGIN` inside the sides of `screen` (the visible frame of the icon's screen).
pub fn popover_origin(tray: Rect, size: (f64, f64), screen: Rect) -> (f64, f64) {
    let centred = tray.x + tray.width / 2.0 - size.0 / 2.0;
    let x = centred
        .min(screen.x + screen.width - size.0 - MARGIN)
        .max(screen.x + MARGIN);
    (x, tray.y + tray.height + GAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (f64, f64) = (380.0, 640.0);
    /// A 1512 × 982 pt screen with a 24 pt menu bar.
    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 24.0,
        width: 1512.0,
        height: 958.0,
    };

    fn icon(x: f64) -> Rect {
        Rect {
            x,
            y: 0.0,
            width: 60.0,
            height: 24.0,
        }
    }

    #[test]
    fn centres_the_popover_under_the_icon() {
        assert_eq!(popover_origin(icon(1000.0), SIZE, SCREEN), (840.0, 30.0));
    }

    #[test]
    fn a_rect_contains_its_top_left_edge_but_not_its_far_edge() {
        assert!(SCREEN.contains(0.0, 24.0) && SCREEN.contains(1000.0, 500.0));
        assert!(!SCREEN.contains(1512.0, 100.0) && !SCREEN.contains(100.0, 982.0) && !SCREEN.contains(-1.0, 100.0));
    }

    #[test]
    fn keeps_the_popover_inside_the_right_edge() {
        assert_eq!(popover_origin(icon(1400.0), SIZE, SCREEN), (1124.0, 30.0));
    }

    #[test]
    fn keeps_the_popover_inside_the_left_edge() {
        let second = Rect { x: -1920.0, ..SCREEN };
        assert_eq!(popover_origin(icon(-1900.0), SIZE, second), (-1912.0, 30.0));
    }

    fn pixels(x: f64, width: f64, height: f64, scale: f64) -> Screen {
        let frame = Rect {
            x: x * scale,
            y: 0.0,
            width: width * scale,
            height: height * scale,
        };
        Screen {
            frame,
            visible: frame,
            scale,
        }
    }

    /// A 2x built-in display (0 to 1512 pt) with a 1x display to its right (1512 to 3432 pt), as Tauri reports them:
    /// each frame in pixels at its own scale, so the two overlap in pixels (0 to 3024, and 1512 to 3432).
    #[test]
    fn finds_the_icon_s_screen_in_points_with_mixed_scales() {
        let screens = [pixels(0.0, 1512.0, 982.0, 2.0), pixels(1512.0, 1920.0, 1080.0, 1.0)];
        // The icon at 1600 pt on the external display: 1600 px is inside both pixel frames.
        assert_eq!(tray_screen(icon(1600.0), &screens), Some(&screens[1]));
        assert!(screens[0].frame.contains(1600.0, 12.0) && screens[1].frame.contains(1600.0, 12.0));
        // The icon at 800 pt on the built-in display, also 1600 px there.
        assert_eq!(tray_screen(icon(800.0), &screens), Some(&screens[0]));
    }

    #[test]
    fn finds_the_only_screen_and_falls_back_to_the_primary() {
        let single = [pixels(0.0, 1512.0, 982.0, 2.0)];
        assert_eq!(tray_screen(icon(1000.0), &single), Some(&single[0]));
        let screens = [pixels(0.0, 1512.0, 982.0, 2.0), pixels(1512.0, 1920.0, 1080.0, 1.0)];
        assert_eq!(tray_screen(icon(5000.0), &screens), Some(&screens[0]));
        assert_eq!(tray_screen(icon(0.0), &[]), None);
    }
}
