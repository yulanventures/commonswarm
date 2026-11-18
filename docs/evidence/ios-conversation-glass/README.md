# Conversation controls

These pictures compare the conversation at the same fixture message, using the same Dynamic Type setting on each side. The screens use synthetic messages. For repeatable captures the review copies signed into the loopback fixture and opened the conversation at message 112.

| Device | System | Before and after |
| --- | --- | --- |
| iPhone 16 | iOS 26.5 | [Light, dark and Reduce Transparency](iphone-16.jpg) |
| iPhone SE (3rd generation) | iOS 26.5 | [Light, dark and Reduce Transparency](iphone-se.jpg) · [Large text](large-text.jpg) |
| iPhone SE (3rd generation) | iOS 18.0 | [Material fallback](ios-18.jpg) |

The reduced-transparency captures also have Increase Contrast and Reduce Motion enabled. The field and floating button use opaque system backgrounds in that configuration.

The on-device XCTest contrast audit passed for the changed controls in light mode. In dark mode it flagged the prompt. The captured element shows common glyph-interior pixels of RGB 195/195/195 over RGB 18/18/18, about 10.6:1 by the WCAG sRGB formula. That measurement is specific to the pictured background. The audit also reported existing timeline labels.

The production app’s reader test used the normal sign-in entry point. It checked the same message stayed in place after an older page loaded, repeated that check through an older-page retry, then tapped Latest and found the final message visible and the button dismissed.

On the iPhone SE, the keyboard stayed open and the draft occupied two lines before and after tapping Latest. The final message ended at 334.9 pt and the draft began at 349 pt, leaving 14.1 pt between them. The same draft text remained editable. [Keyboard comparison](keyboard.jpg)
