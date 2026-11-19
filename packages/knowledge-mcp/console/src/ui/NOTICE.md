# Components from affectUI

The files in this folder are copied from [affectUI](https://github.com/flohoeller/affectui) by Florian Höller,
used under the MIT License. They are the "clean" variants of the free components, taken from commit
`dffb785adc13dece05a5b02a8e06b7f8100cee10`.

| File here | File there |
| --- | --- |
| `button.tsx` | `components/button-clean.tsx` |
| `text-field.tsx` | `components/text-field-clean.tsx` |
| `text-area.tsx` | `components/text-area-clean.tsx` |
| `select.tsx` | `components/select-clean.tsx` |
| `switch.tsx` | `components/switch-clean.tsx` |
| `dialog.tsx` | `components/dialog-clean.tsx` |
| `badge.tsx` | `components/badge-clean.tsx` |
| `code-block.tsx` | `components/code-block-clean.tsx` |
| `empty-state.tsx` | `components/empty-state-clean.tsx` |
| `spinner.tsx` | `components/spinner-clean.tsx` |
| `segmented-control.tsx` | `components/segmented-control-clean.tsx` |
| `tool-call-card.tsx` | `components/tool-call-card-clean.tsx` |
| `thinking-loader.tsx` | `components/thinking-loader-clean.tsx` |
| `message-actions.tsx` | `components/message-actions-clean.tsx` |

Changes made to the copies:

1. The `"use client"` line at the top is removed (this page is not a server-rendered app).
2. Text set at 10px or 11px is set at 12px, the smallest size this console uses.

Nothing else is changed. To update a component, copy the file again from the same path and reapply the two changes.

## License of the copied files

MIT License

Copyright (c) 2026 Florian Höller (adfects)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
