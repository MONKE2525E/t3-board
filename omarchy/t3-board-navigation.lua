-- Managed by T3 Board. Super+function key follows its current LED assignment.
for index = 1, 12 do
  local key = "F" .. index
  o.bind("SUPER + " .. key, "T3 Board: open " .. key .. " thread", "t3-boardctl jump " .. key)
end
o.bind("SUPER + DELETE", "T3 Board: open Del thread", "t3-boardctl jump Del")

-- The key below Esc opens its agent; Super+Esc keeps Omarchy's system menu.
o.bind("SUPER + GRAVE", "T3 Board: open Esc thread", "t3-boardctl jump Esc")
