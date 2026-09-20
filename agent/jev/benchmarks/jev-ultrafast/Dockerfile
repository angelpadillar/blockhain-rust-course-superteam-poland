FROM python:3.12-slim
WORKDIR /work
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY jev_ultrafast-0.1.0-py3-none-any.whl ./
RUN pip install --no-cache-dir --no-deps jev_ultrafast-0.1.0-py3-none-any.whl
COPY live_benchmark.py prompts.py prompts_v1.py metrics.py foczka-navigation.json ./
USER 1000:1000
ENTRYPOINT ["python", "-u", "live_benchmark.py"]
