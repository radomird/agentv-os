/* AgenTV's home screen colours, from the Omarchy theme (ADR-012). Omarchy
   renders this into the current theme on every theme change, and AgenTV's
   theme-set hook hands the result to the TV. */
:root {
  --background: {{ background }};
  --dark-background: {{ dark_background }};
  --darker-background: {{ darker_background }};
  --lighter-background: {{ lighter_background }};
  --foreground: {{ foreground }};
  --dark-foreground: {{ dark_foreground }};
  --bright-foreground: {{ bright_foreground }};
  --accent: {{ accent }};
  --selection: {{ selection }};
  --muted: {{ muted }};
  --red: {{ red }};
  --yellow: {{ yellow }};
  --orange: {{ orange }};
  --green: {{ green }};
  --cyan: {{ cyan }};
  --blue: {{ blue }};
  --magenta: {{ magenta }};
  --bright-yellow: {{ bright_yellow }};
  --bright-cyan: {{ bright_cyan }};
  --bright-magenta: {{ bright_magenta }};
}
