Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile("C:\Users\owner\capri\tune\tts.wav", $fmt)
$s.Speak("Let me check the logs first. Capri. The dashboard looks fine today. Capri. We drove to the coast. Hey Capri. I bought a cap. Ripe apricots. Cap reading. Capri, what is the status. Calorie count. Happy birthday.")
$s.Dispose()
