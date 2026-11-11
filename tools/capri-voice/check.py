import sys; sys.path.insert(0, r"C:\Users\owner\capri-voice")
from voice.ears import add_cuda_dlls; add_cuda_dlls()
import onnxruntime as ort, ctranslate2
print("ort", ort.__version__, ort.get_available_providers())
print("ct2", ctranslate2.__version__, ctranslate2.get_cuda_device_count())
