# RollitoVM hardware Makefile (top-level).
#
# Targets:
#   make image            Build el container Docker del toolchain.
#   make smoke            Ejecuta yosys/nextpnr/verilator -V dentro del container.
#   make verilate         Compila el RTL (cuando exista) con Verilator.
#   make synth            Sintetiza para ECP5 25F.
#   make sim              Corre la cosim contra los juegos del repo.
#   make prog             Programa la FPGA via openFPGALoader.
#   make clean            Borra build/.

IMAGE      := rollitovm-rtl
DOCKER_RUN := docker run --rm -v "$$PWD/..:/work" -w /work/hw $(IMAGE)

.PHONY: image smoke verilate synth sim prog clean

image:
	docker build -t $(IMAGE) .

smoke: image
	$(DOCKER_RUN) bash -c 'yosys -V && nextpnr-ecp5 --version && verilator --version'

verilate: image
	@echo "TODO: agregar reglas Verilator cuando exista cpu/rvm32_top.v"
	# $(DOCKER_RUN) verilator --cc --exe --build cpu/rvm32_top.v sim/Vrvm32_top.cpp -o rvm32_sim

synth: image
	@echo "TODO: agregar yosys synth + nextpnr-ecp5 + ecppack"
	# $(DOCKER_RUN) bash -c 'yosys -p "synth_ecp5 -json build/rvm32.json" cpu/*.v gpu/*.v synth/*.v'
	# $(DOCKER_RUN) nextpnr-ecp5 --json build/rvm32.json --textcfg build/rvm32.cfg \
	#                            --25k --package CABGA381 --speed 6 --lpf ecp5/rvm32.lpf
	# $(DOCKER_RUN) ecppack build/rvm32.cfg build/rvm32.bit

sim: image
	@echo "TODO: cosim contra el JS golden reference"

prog:
	@echo "Requiere FPGA conectado via JTAG/USB"
	docker run --rm --device=/dev/bus/usb -v "$$PWD/..:/work" -w /work/hw $(IMAGE) \
	  openFPGALoader -b colorlight-i5 build/rvm32.bit

clean:
	rm -rf build/
