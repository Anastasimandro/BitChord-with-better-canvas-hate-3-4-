import sys
import os

# Add common Python paths
python_paths = [
    r"C:\Python311\python.exe",
    r"C:\Python310\python.exe",
    r"C:\Python39\python.exe",
    r"C:\Users\A\AppData\Local\Programs\Python\Python311\python.exe",
    r"C:\Users\A\AppData\Local\Programs\Python\Python310\python.exe",
    r"C:\Users\A\AppData\Local\Programs\Python\Python39\python.exe",
    r"C:\Program Files\Python311\python.exe",
    r"C:\Program Files\Python310\python.exe",
    r"C:\Program Files\Python39\python.exe",
]

for py_path in python_paths:
    if os.path.exists(py_path):
        print(f"Found Python at {py_path}")
        import subprocess
        result = subprocess.run([py_path, "-c", 
            "import yaml; content=open('.github/workflows/android-npu-tests.yml', 'r').read(); yaml.safe_load(content); print('YAML is valid')"
        ], capture_output=True, text=True)
        print(result.stdout)
        print(result.stderr)
        break
else:
    print("Python not found in common locations")