import sounddevice as sd
print(sd.default.device)
for i, d in enumerate(sd.query_devices()):
    if d["hostapi"] == 0: print(i, d["name"], d["max_input_channels"], d["max_output_channels"])
print(sd.query_hostapis()[0]["name"])
