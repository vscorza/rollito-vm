# RTL toolchain reproducible para RollitoVM (PLAN §19, RTL-PLAN.md).
#
# Imagen Debian-slim con todo lo necesario para sintetizar, simular y
# programar un FPGA Lattice ECP5 — sólo herramientas open-source.
#
# Build:    docker build -t rollitovm-rtl hw/
# Run:      docker run --rm -v "$PWD:/work" -w /work rollitovm-rtl <cmd>
# Programar FPGA: docker run --rm --device=/dev/bus/usb …

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/oss-cad-suite/bin:${PATH}"

# 1) Dependencias base. Pinneamos a versiones presentes en bookworm.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      libusb-1.0-0-dev \
      libftdi1-dev \
      libreadline-dev \
      libffi-dev \
      libtcl8.6 \
      libgmp-dev \
      python3 \
      python3-pip \
      pkg-config \
      tar \
      xz-utils \
      verilator \
      iverilog \
      gtkwave \
    && rm -rf /var/lib/apt/lists/*

# 2) OSS CAD Suite — Yosys + nextpnr-ecp5 + Project Trellis + ecppack
#    + openFPGALoader, todo en un tarball. ~250 MB instalado.
#    Pinear la fecha del release garantiza builds reproducibles.
ARG OSS_CAD_DATE=2025-04-15
ARG OSS_CAD_URL=https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${OSS_CAD_DATE}/oss-cad-suite-linux-x64-$(echo ${OSS_CAD_DATE} | tr -d -).tgz
RUN mkdir -p /opt && cd /opt && \
    curl -fsSL -o oss-cad-suite.tgz "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${OSS_CAD_DATE}/oss-cad-suite-linux-x64-$(echo ${OSS_CAD_DATE} | tr -d -).tgz" && \
    tar -xzf oss-cad-suite.tgz && rm oss-cad-suite.tgz

# 3) cocotb para testbenches en Python (opcional pero útil).
RUN pip3 install --break-system-packages --no-cache-dir cocotb==1.8.* cocotb-test

# 4) Smoke test (build-time): asegurar que las herramientas arrancan.
RUN yosys -V && nextpnr-ecp5 --version && ecppack --version && \
    verilator --version && iverilog -V

WORKDIR /work
CMD ["bash"]
