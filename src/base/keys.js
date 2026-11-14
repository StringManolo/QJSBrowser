export const ASCII = {
  ESC:        27,
  CTRL_C:     3,
  CTRL_T:     20,
  CTRL_U:     21,
  CTRL_W:     23,
  CTRL_L:     12,
  BACKSPACE:  127,
  BACKSPACE2: 8,
  ENTER:      13,
  ENTER2:     10,
  SPACE:      32,
  TAB:        9,
};

export function buildKeyMap(tui) {
  return {
    ...ASCII,
    ARROW_LEFT:  tui.KEY_LEFT,
    ARROW_RIGHT: tui.KEY_RIGHT,
    ARROW_UP:    tui.KEY_UP,
    ARROW_DOWN:  tui.KEY_DOWN,
    HOME:        tui.KEY_HOME,
    END:         tui.KEY_END,
    DELETE:      tui.KEY_DC,
    NC_ENTER:    tui.KEY_ENTER,
    NC_BACKSP:   tui.KEY_BACKSPACE,
    KEY_MOUSE:   tui.KEY_MOUSE,
    ERR:         tui.ERR,
  };
}
