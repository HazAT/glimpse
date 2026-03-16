/// Safe zone constants matching the Swift binary.
const SAFE_LEFT: f64 = 20.0;
const SAFE_RIGHT: f64 = 27.0;
const SAFE_UP: f64 = 15.0;
const SAFE_DOWN: f64 = 39.0;

/// Compute the target window position given cursor position, window size,
/// optional anchor, and offset. Returns (x, y) in screen coordinates.
pub fn compute_target(
    cursor_x: f64,
    cursor_y: f64,
    win_w: f64,
    win_h: f64,
    anchor: Option<&str>,
    offset_x: f64,
    offset_y: f64,
) -> (f64, f64) {
    match anchor {
        Some("top-left") => (
            cursor_x - SAFE_LEFT - win_w + offset_x,
            cursor_y - SAFE_UP - win_h + offset_y,
        ),
        Some("top-right") => (
            cursor_x + SAFE_RIGHT + offset_x,
            cursor_y - SAFE_UP - win_h + offset_y,
        ),
        Some("right") => (
            cursor_x + SAFE_RIGHT + offset_x,
            cursor_y - win_h / 2.0 + offset_y,
        ),
        Some("bottom-right") => (
            cursor_x + SAFE_RIGHT + offset_x,
            cursor_y + SAFE_DOWN + offset_y,
        ),
        Some("bottom-left") => (
            cursor_x - SAFE_LEFT - win_w + offset_x,
            cursor_y + SAFE_DOWN + offset_y,
        ),
        Some("left") => (
            cursor_x - SAFE_LEFT - win_w + offset_x,
            cursor_y - win_h / 2.0 + offset_y,
        ),
        _ => (cursor_x + offset_x, cursor_y + offset_y),
    }
}

/// Compute cursorTip — the CSS position of the cursor within the window.
/// Returns (x, y) in CSS pixels, or None if not following cursor.
pub fn compute_cursor_tip(
    win_w: f64,
    win_h: f64,
    anchor: Option<&str>,
    offset_x: f64,
    offset_y: f64,
) -> Option<(i32, i32)> {
    match anchor {
        Some(a) => {
            // Compute anchor position with cursor at (0,0) to get the constant offset
            let (base_x, base_y) = compute_target(0.0, 0.0, win_w, win_h, Some(a), offset_x, offset_y);
            // cssX = cursor_x - window_x = 0 - base_x = -base_x
            // cssY = cursor_y - window_y (top-down) = 0 - base_y
            // But we need CSS coords (top-down). In Swift:
            // cssX = 0 - base.x - offsetX (but offset already in base for us)
            // cssY = H - (0 - base.y - offsetY)
            let css_x = -base_x as i32;
            let css_y = (win_h - (-base_y)) as i32;
            Some((css_x, css_y))
        }
        None => {
            // Offset-only mode: cssX = -offsetX, cssY = H + offsetY
            let css_x = -offset_x as i32;
            let css_y = (win_h + offset_y) as i32;
            Some((css_x, css_y))
        }
    }
}

/// Spring physics state matching Swift: stiffness=400, damping=28, dt=1/120
pub struct SpringState {
    pub pos: (f64, f64),
    pub vel: (f64, f64),
    pub target: (f64, f64),
}

impl SpringState {
    pub const STIFFNESS: f64 = 400.0;
    pub const DAMPING: f64 = 28.0;
    pub const DT: f64 = 1.0 / 120.0;
    pub const SETTLE_THRESHOLD: f64 = 0.5;

    pub fn new(pos: (f64, f64)) -> Self {
        Self {
            pos,
            vel: (0.0, 0.0),
            target: pos,
        }
    }

    /// Advance one physics step. Returns true if settled.
    pub fn tick(&mut self) -> bool {
        let dx = self.target.0 - self.pos.0;
        let dy = self.target.1 - self.pos.1;
        let fx = Self::STIFFNESS * dx - Self::DAMPING * self.vel.0;
        let fy = Self::STIFFNESS * dy - Self::DAMPING * self.vel.1;
        self.vel.0 += fx * Self::DT;
        self.vel.1 += fy * Self::DT;
        self.pos.0 += self.vel.0 * Self::DT;
        self.pos.1 += self.vel.1 * Self::DT;

        let dist = (dx * dx + dy * dy).sqrt();
        let vel = (self.vel.0 * self.vel.0 + self.vel.1 * self.vel.1).sqrt();
        if dist < Self::SETTLE_THRESHOLD && vel < Self::SETTLE_THRESHOLD {
            self.pos = self.target;
            self.vel = (0.0, 0.0);
            true
        } else {
            false
        }
    }
}
