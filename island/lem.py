"""Landscape evolution on a regular grid (numba): priority-flood routing, D8 receivers, drainage stack, and an implicit
stream-power step (Braun & Willett 2013, FastScape) with a threshold-hillslope limiter.

All arrays are flat (index = row * n + col); cells are dx metres square. `fixed` marks base-level cells (the sea and the
domain edge): they neither erode nor route.
"""
import numpy as np
from numba import njit, prange

DR = np.array([-1, -1, -1, 0, 0, 1, 1, 1], np.int64)
DC = np.array([-1, 0, 1, -1, 1, -1, 0, 1], np.int64)
DD = np.array([1.41421356, 1.0, 1.41421356, 1.0, 1.0, 1.41421356, 1.0, 1.41421356])


@njit(cache=True)
def _heap_push(hh, hi, size, v, i):
    k = size
    hh[k] = v; hi[k] = i
    while k > 0:
        p = (k - 1) >> 1
        if hh[p] <= hh[k]:
            break
        hh[p], hh[k] = hh[k], hh[p]
        hi[p], hi[k] = hi[k], hi[p]
        k = p
    return size + 1


@njit(cache=True)
def _heap_pop(hh, hi, size):
    top = hi[0]
    size -= 1
    hh[0] = hh[size]; hi[0] = hi[size]
    k = 0
    while True:
        l = 2 * k + 1
        if l >= size:
            break
        c = l
        if l + 1 < size and hh[l + 1] < hh[l]:
            c = l + 1
        if hh[k] <= hh[c]:
            break
        hh[c], hh[k] = hh[k], hh[c]
        hi[c], hi[k] = hi[k], hi[c]
        k = c
    return top, size


@njit(cache=True)
def priority_flood(h, fixed, n, eps):
    """Depression-filled copy of h (Barnes et al. 2014, priority-flood + epsilon): every cell gets a strictly descending
    path to a fixed cell. Used for routing only."""
    N = n * n
    hf = h.copy()
    closed = np.zeros(N, np.bool_)
    hh = np.empty(N, np.float64); hi = np.empty(N, np.int64); hs = 0
    pit = np.empty(N, np.int64); ph = 0; pt = 0
    for i in range(N):
        if fixed[i]:
            closed[i] = True
            hs = _heap_push(hh, hi, hs, hf[i], i)
    while hs > 0 or ph < pt:
        if ph < pt:
            c = pit[ph]; ph += 1
        else:
            c, hs = _heap_pop(hh, hi, hs)
        r = c // n; q = c - r * n
        for k in range(8):
            rr = r + DR[k]; qq = q + DC[k]
            if rr < 0 or rr >= n or qq < 0 or qq >= n:
                continue
            j = rr * n + qq
            if closed[j]:
                continue
            closed[j] = True
            if hf[j] <= hf[c] + eps:
                hf[j] = hf[c] + eps
                pit[pt] = j; pt += 1
            else:
                hs = _heap_push(hh, hi, hs, hf[j], j)
        if ph == pt:
            ph = 0; pt = 0
    return hf


@njit(cache=True)
def receivers(hf, fixed, n, dx):
    """Steepest-descent (D8) receiver of every cell on the filled surface, and the distance to it."""
    N = n * n
    rec = np.arange(N)
    dist = np.full(N, dx)
    for i in range(N):
        if fixed[i]:
            continue
        r = i // n; q = i - r * n
        best = 0.0; bj = i; bd = dx
        for k in range(8):
            rr = r + DR[k]; qq = q + DC[k]
            if rr < 0 or rr >= n or qq < 0 or qq >= n:
                continue
            j = rr * n + qq
            d = DD[k] * dx
            s = (hf[i] - hf[j]) / d
            if s > best:
                best = s; bj = j; bd = d
        rec[i] = bj; dist[i] = bd
    return rec, dist


@njit(cache=True)
def receivers_stochastic(hf, fixed, n, dx, rnd, p):
    """Receiver drawn among all downslope neighbours with probability ∝ slope^p (a fresh draw every step): over time the
    network forgets the grid's eight directions, and valleys run any way the land falls."""
    N = n * n
    rec = np.arange(N)
    dist = np.full(N, dx)
    w = np.empty(8)
    for i in range(N):
        if fixed[i]:
            continue
        r = i // n; q = i - r * n
        tot = 0.0
        for k in range(8):
            w[k] = 0.0
            rr = r + DR[k]; qq = q + DC[k]
            if rr < 0 or rr >= n or qq < 0 or qq >= n:
                continue
            s = (hf[i] - hf[rr * n + qq]) / (DD[k] * dx)
            if s > 0.0:
                w[k] = s ** p
                tot += w[k]
        if tot <= 0.0:
            continue
        pick = rnd[i] * tot
        for k in range(8):
            if w[k] <= 0.0:
                continue
            pick -= w[k]
            if pick <= 0.0:
                rec[i] = (r + DR[k]) * n + q + DC[k]; dist[i] = DD[k] * dx
                break
        if rec[i] == i:                      # rounding: take the last candidate
            for k in range(7, -1, -1):
                if w[k] > 0.0:
                    rec[i] = (r + DR[k]) * n + q + DC[k]; dist[i] = DD[k] * dx
                    break
    return rec, dist


@njit(cache=True)
def stack_order(rec, n):
    """Cells ordered from base level upstream (every cell after its receiver)."""
    N = n * n
    ndon = np.zeros(N, np.int64)
    for i in range(N):
        if rec[i] != i:
            ndon[rec[i]] += 1
    start = np.zeros(N + 1, np.int64)
    for i in range(N):
        start[i + 1] = start[i] + ndon[i]
    fill = start[:-1].copy()
    don = np.empty(max(start[N], 1), np.int64)
    for i in range(N):
        r = rec[i]
        if r != i:
            don[fill[r]] = i; fill[r] += 1
    stack = np.empty(N, np.int64); ns = 0
    todo = np.empty(N, np.int64)
    for b in range(N):
        if rec[b] != b:
            continue
        nt = 0
        todo[nt] = b; nt += 1
        while nt > 0:
            nt -= 1
            c = todo[nt]
            stack[ns] = c; ns += 1
            for k in range(start[c], start[c + 1]):
                todo[nt] = don[k]; nt += 1
    return stack


@njit(cache=True)
def drainage_area(stack, rec, cell_area, rain):
    """Upstream area (m², weighted by rainfall) of every cell."""
    A = cell_area * rain.copy()
    for k in range(stack.size - 1, -1, -1):
        i = stack[k]; r = rec[i]
        if r != i:
            A[r] += A[i]
    return A


@njit(cache=True)
def ice_flux(stack, rec, b, dx=0.0, cw=1.3, wmax=3500.0):
    """Ice discharge (m³/yr) along the drainage network: every cell adds its surface mass balance b (m³/yr — snow
    accumulation above the equilibrium line, melt below it) to the ice arriving from upstream; the flux can't go below
    zero, so a glacier ends where melt has eaten all it carries. Ice reaching base level (the sea) calves away.

    A glacier melts over its whole width, not just the one cell of its flow line: with dx > 0, melt on a cell that
    carries ice is scaled by the glacier's width there (cw·Q^0.4, as in glacial.width) over the cell size. Snow needs
    no such scaling: the cells beside a glacier route their own accumulation into it."""
    N = b.size
    Q = np.zeros(N)
    for k in range(N - 1, -1, -1):
        i = stack[k]
        bi = b[i]
        if bi < 0.0 and dx > 0.0 and Q[i] > 0.0:
            w = cw * Q[i] ** 0.4
            if w > wmax:
                w = wmax
            if w > dx:
                bi *= w / dx
        q = Q[i] + bi
        if q < 0.0:
            q = 0.0
        Q[i] = q
        r = rec[i]
        if r != i:
            Q[r] += q
    return Q


@njit(cache=True)
def erode(h, stack, rec, dist, A, K, U, dt, m, fixed, G, cell_area, iters):
    """One implicit step of stream power with deposition (the ξ–q model of Davy & Lague, solved as in Yuan et al.
    2019): dh/dt = U − K A^m S + (G / A) Qs, Qs the sediment flux arriving from upstream. Rivers carry what they erode
    and drop it where they lose power — flat valley floors, floodplains, fans at the mountain front. G = 0 is pure
    detachment-limited erosion. Cells in depressions are raised toward their outlet (lake infill)."""
    N = h.size
    h0 = h.copy()
    Qs = np.zeros(N)
    for it in range(iters):
        for k in range(stack.size):
            i = stack[k]
            if fixed[i]:
                continue
            r = rec[i]
            hn = h0[i] + dt * (U[i] + G * Qs[i] / A[i])
            if r == i:
                h[i] = hn
                continue
            F = K[i] * dt * A[i] ** m / dist[i]
            h[i] = (hn + F * h[r]) / (1.0 + F)
        if G <= 0.0:
            break
        # sediment flux into each cell: everything eroded (net of deposition) upstream of it
        for k in range(N):
            Qs[k] = 0.0
        for k in range(stack.size - 1, -1, -1):
            i = stack[k]; r = rec[i]
            if r != i:
                q = Qs[i] + (U[i] - (h[i] - h0[i]) / dt) * cell_area
                Qs[r] += q if q > 0.0 else 0.0


@njit(parallel=True, cache=True)
def hillslope(h, fixed, n, dx, Sc, kappa, dt, iters, rate):
    """Isotropic hillslope processes: soil creep (linear diffusion, kappa m²/yr per cell, over dt) and landsliding — material
    above the critical slope Sc (tan of the angle, per cell) slides to every lower neighbour (talus relaxation)."""
    N = n * n
    dh = np.zeros(N)
    kmax = kappa.max()
    if kmax > 0.0:
        sub = max(1, int(np.ceil(4.0 * kmax * dt / (dx * dx) * 1.2)))
        c = dt / sub / (dx * dx)
        for s in range(sub):
            for i in prange(N):
                r = i // n; q = i - r * n
                if fixed[i] or r == 0 or q == 0 or r == n - 1 or q == n - 1:
                    dh[i] = 0.0
                    continue
                dh[i] = c * kappa[i] * (h[i - 1] + h[i + 1] + h[i - n] + h[i + n] - 4.0 * h[i])
            for i in prange(N):
                h[i] += dh[i]
    for it in range(iters):
        for i in prange(N):
            r = i // n; q = i - r * n
            if r == 0 or q == 0 or r == n - 1 or q == n - 1:
                dh[i] = 0.0
                continue
            acc = 0.0
            for k in range(8):
                j = (r + DR[k]) * n + q + DC[k]
                d = DD[k] * dx
                lim = 0.5 * (Sc[i] + Sc[j]) * d
                e = h[j] - h[i] - lim          # neighbour too far above: receives
                if e > 0.0 and not fixed[j]:
                    acc += e
                e = h[i] - h[j] - lim          # too far above the neighbour: sheds
                if e > 0.0:
                    acc -= e
            dh[i] = 0.0 if fixed[i] else acc * rate
        for i in prange(N):
            h[i] += dh[i]


@njit(cache=True)
def step(h, fixed, n, dx, K, U, rain, dt, m, Sc, eps, rnd, kappa, titers, G):
    """One landscape-evolution step. rnd: uniform randoms per cell for the stochastic receivers."""
    hf = priority_flood(h, fixed, n, eps)
    rec, dist = receivers_stochastic(hf, fixed, n, dx, rnd, 1.3)
    st = stack_order(rec, n)
    A = drainage_area(st, rec, dx * dx, rain)
    erode(h, st, rec, dist, A, K, U, dt, m, fixed, G, dx * dx, 3)
    hillslope(h, fixed, n, dx, Sc, kappa, dt, titers, 0.06)
    return A, rec


def flow(h, fixed, n, dx, rain=None, eps=1e-3):
    """Routing products for a finished surface: drainage area, receivers, stack, filled surface."""
    if rain is None:
        rain = np.ones(n * n)
    hf = priority_flood(h, fixed, n, eps)
    rec, dist = receivers(hf, fixed, n, dx)
    st = stack_order(rec, n)
    A = drainage_area(st, rec, dx * dx, rain)
    return A, rec, dist, st, hf
