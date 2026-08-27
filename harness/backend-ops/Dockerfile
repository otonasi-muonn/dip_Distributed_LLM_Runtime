# Build llama.cpp's own tests/test-backend-ops for the browser.
#
# "The MUL_MAT_ID shader ran" is not the same claim as "it computed the right
# numbers". test-backend-ops is upstream's answer to the second question: it runs
# each op on the backend under test and on the CPU backend in the same process and
# compares the results, so it is the tool to reuse rather than a comparison we write.
#
# The pinned fork already covers what we need - test_mul_mat_id is registered over
# base_types and other_types, and other_types contains Q2_K and Q3_K, which are the
# expert quantisations in the Qwen3.6 build we selected.
#
# Build context is the llmlet checkout (.work/llmlet), because the test needs the
# llama.cpp sources under it:
#
#     docker build -f harness/backend-ops/Dockerfile --output type=local,dest=<out> .work/llmlet
#
# The first stage is copied verbatim from the llmlet Dockerfile so Docker reuses the
# cached Dawn layer instead of building Dawn again. Keep it byte-identical.

FROM emscripten/emsdk:5.0.2 AS build-dawn

RUN apt-get update && apt-get install -y pkg-config

ENV EMCC_CFLAGS="-g -O3 -pthread -sMEMORY64=2 -msimd128"

RUN git clone https://dawn.googlesource.com/dawn /dawn && \
    cd /dawn && \
    git checkout 4e424acfe8019629d312cabe7242215d0206b32c && \
    python3 tools/fetch_dawn_dependencies.py && \
    mkdir -p /build /build-dawn && \
    cd /build-dawn && \
    emcmake cmake /dawn && \
    make -j$(nproc) emdawnwebgpu_pkg

FROM emscripten/emsdk:5.0.2 AS build-test

COPY --from=build-dawn /build-dawn /build-dawn
COPY . /work/
WORKDIR /work/llama.cpp

# Same compile flags as the llmlet reference build: the point of this harness is to
# exercise the shaders as the Runtime will actually ship them.
ENV EMCC_CFLAGS="-g -O3 -pthread -sMEMORY64=2 -msimd128"

# GGML_RPC is off on purpose. The fork replaces the RPC socket layer with extern
# functions (recv_peer, send_peer, ...) that llmlet implements in libllmlet.js, so
# linking libggml-rpc.a here fails on undefined symbols unless that JS library comes
# along too. This gate asks whether the WebGPU kernels compute the right numbers
# against the CPU reference, which does not involve RPC at all.
#
# PROXY_TO_PTHREAD is not optional here. The WebGPU backend awaits device work, and
# the emdawnwebgpu port routes that through JSPI, so main() must not be the browser
# main thread. LLAMA_BUILD_HTML is off because the generated shell page has neither
# our COOP/COEP setup nor anywhere to show stdout; harness/backend-ops/index.html
# does both.
RUN emcmake cmake -B /tb \
        -DGGML_WEBGPU=ON \
        -DEMDAWNWEBGPU_DIR=/build-dawn/emdawnwebgpu_pkg \
        -DGGML_WEBGPU_JSPI=ON \
        -DGGML_RPC=OFF \
        -DLLAMA_CURL=OFF \
        -DLLAMA_BUILD_TESTS=ON \
        -DLLAMA_BUILD_TOOLS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_BUILD_SERVER=OFF \
        -DLLAMA_BUILD_HTML=OFF \
        -DCMAKE_EXE_LINKER_FLAGS="-pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sASSERTIONS=1 -sSTACK_SIZE=4MB -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=FS,PThread,ENV,TTY -fwasm-exceptions" \
    && cmake --build /tb --target test-backend-ops -j$(nproc) \
    && mkdir -p /out \
    && find /tb -name "test-backend-ops.js" -exec cp {} /out/ \; \
    && find /tb -name "test-backend-ops.wasm" -exec cp {} /out/ \; \
    && ls -la /out

FROM scratch
COPY --from=build-test /out/test-backend-ops.js /
COPY --from=build-test /out/test-backend-ops.wasm /
