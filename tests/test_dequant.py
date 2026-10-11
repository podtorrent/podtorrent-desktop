"""PyTorch unpacking of MLX quantized weights must match mx.dequantize exactly."""
import mlx.core as mx
import numpy as np
import pytest
import torch

from podtorrent.shard_torch import dequantize


def to_torch(a: mx.array) -> torch.Tensor:
    if a.dtype == mx.uint32:
        return torch.from_numpy(np.array(a).view(np.int32))
    return torch.from_numpy(np.array(a.astype(mx.float32)))


@pytest.mark.parametrize("bits", [2, 4, 8])
@pytest.mark.parametrize("shape", [(96, 256), (3, 40, 128)])
def test_matches_mlx(bits, shape):
    mx.random.seed(bits)
    w = mx.random.normal(shape).astype(mx.bfloat16)
    q, s, b = mx.quantize(w, group_size=64, bits=bits)
    want = np.array(mx.dequantize(q, s, b, group_size=64, bits=bits).astype(mx.float32))
    got = dequantize(to_torch(q), to_torch(s).bfloat16(), to_torch(b).bfloat16(), 64).numpy()
    np.testing.assert_allclose(got, want, rtol=1e-2, atol=1e-2)
