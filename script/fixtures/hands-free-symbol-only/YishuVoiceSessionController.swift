func setContinuousListeningEnabled(_ enabled: Bool) {}
func beginContinuousUtterance() {}
var continuousPhase = Phase.armed
func disarmContinuousListening() { sessionGeneration &+= 1 }
let didEmitTerminalForGeneration = false
func emptyOrNearSilence() {}
func startPushToTalkFromKeyboardShortcut() {}
func handleShortcutTransition() {}
enum Event { case speechOnset }
