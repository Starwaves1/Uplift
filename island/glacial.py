"""Glacial erosion for the landscape model: where ice flows, how thick it is, and how fast it grinds its bed.

Ice discharge Q (m³/yr) comes from routing the surface mass balance down the drainage network (lem.ice_flux). A glacier
carrying Q is W = cw·Q^0.4 wide (a large outlet glacier moving 4.5·10⁷ m³/yr is ~1.5 km wide). Its surface is that of a
perfectly plastic glacier (Nye 1952; the reconstruction method of Benn & Hulton 2010): the surface rises from each snout
or calving front with slope c/H, c = τ_b/(ρ_i g) ≈ 11–15 m and H the ice thickness — along the flow lines, level across
each glacier, and nowhere above the 2D plastic surface rising from every ice margin (the sea, ice-free land). So ice is
thin and steep near its ends (also on the seaward side of a glacier running along the coast), thickens far from them,
fills overdeepenings and thins over rock bars. Mean sliding speed is u = Q/(W·H), and the bed erodes at
E = Kg·uref·(u/uref)^l (abrasion and quarrying rise steeply with sliding speed: l ≈ 2 in the field), spread across the
glacier's width with a plug-flow profile, fast and even over the floor and dying away at the margins. So:
  - valleys turn into flat-floored troughs with steep walls;
  - big fast glaciers cut far deeper than their slow tributaries (hanging valleys);
  - slow ice on the uplands barely scours, while the outlet glaciers cut down, below sea level at the coast (fjords);
  - an overdeepening stops growing once the ice climbing out of it is thick and slow, and where the bed rises out of
    it faster than ~1.5× the ice surface falls, meltwater freezes on at the bed and erosion stops (Alley et al. 2003):
    basins stay behind sills, as at fjord mouths.
"""
import numpy as np
from numba import njit
from scipy import ndimage
from lem import DR, DC, DD, _heap_push, _heap_pop


def width(Q, cw=1.3, Wmin=40.0, Wmax=3500.0):
    """Width (m) of a glacier carrying Q m³/yr."""
    return np.clip(cw * np.maximum(Q, 0) ** 0.4, Wmin, Wmax)


@njit(cache=True)
def surface(stack, rec, dist, B, Q, fixed, c, Qmin):
    """Ice surface (m) along the flow network, walking upstream from base level: a cell carrying ice (Q > Qmin) sits
    y above its receiver, with y·H̄ = c·dist (H̄ the mean thickness of the two, solved as a quadratic). Snouts (whose
    receiver carries no ice) and calving fronts (a fixed receiver) start from the bed. Off the ice S = B."""
    N = B.size
    S = B.copy()
    for k in range(N):
        i = stack[k]
        if fixed[i] or Q[i] <= Qmin:
            continue
        r = rec[i]
        if r == i:
            continue
        Hr = S[r] - B[r]
        if Hr < 0.0:
            Hr = 0.0
        p = S[r] - B[i] + Hr
        y = 0.5 * (-p + np.sqrt(p * p + 8.0 * c * dist[i]))
        s = S[r] + y
        S[i] = s if s > B[i] else B[i]
    return S


@njit(cache=True)
def _centre_rate(B, S, Q, W, fixed, Kg, Qmin, Hmin, umax, l, uref):
    """Bed erosion rate on the flow-line cells: Kg·uref·(u/uref)^l, u = Q/(W·H) — Kg m/yr of erosion per m/yr of sliding
    at uref."""
    N = B.size
    E = np.zeros(N)
    for i in range(N):
        if fixed[i] or Q[i] <= Qmin:
            continue
        H = S[i] - B[i]
        if H < Hmin:
            H = Hmin
        u = Q[i] / (W[i] * H)
        if u > umax:
            u = umax
        E[i] = Kg * uref * (u / uref) ** l
    return E


@njit(cache=True)
def _adverse(rec, dist, B, S, ice, fixed, kappa, look):
    """Per ice cell, the share of its erosion that survives the adverse-slope limit: 0 where the bed along the cell's
    downstream path (the next `look` cells) climbs faster than kappa × the ice surface falls, 1 below half of that."""
    N = B.size
    f = np.ones(N)
    for i in range(N):
        if not ice[i]:
            continue
        j = i
        L = 0.0
        bmax = B[i]
        for s in range(look):
            r = rec[j]
            if r == j:
                break
            L += dist[j]
            j = r
            if B[j] > bmax:
                bmax = B[j]
            if fixed[j]:
                break
        if L > 0.0 and bmax > B[i]:
            lim = kappa * (S[i] - S[j]) / L
            if lim <= 0.0:
                f[i] = 0.0
            else:
                v = (lim - (bmax - B[i]) / L) / (0.5 * lim)
                f[i] = 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)
    return f


@njit(cache=True)
def plastic2d(B, foot, n, dx, c):
    """The perfectly plastic ice surface over a footprint in 2D: the lowest surface that rises from every margin (the
    cells outside `foot`: the sea, ice-free land) no faster than c/H in any direction — Nye's profile generalised to a
    map (an eikonal problem, solved exactly by Dijkstra since a cell's surface only grows with its neighbour's). Near a
    calving front or an ice-free margin the ice is thin; far from all margins it can be thick. Off the footprint S = B."""
    N = n * n
    S = B.copy()
    done = np.zeros(N, np.bool_)
    hh = np.empty(8 * N, np.float64); hi = np.empty(8 * N, np.int64); hs = 0
    for i in range(N):
        if foot[i]:
            S[i] = np.inf
    for i in range(N):
        if foot[i]:
            continue
        r = i // n; q = i - r * n
        for k in range(8):
            rr = r + DR[k]; qq = q + DC[k]
            if 0 <= rr < n and 0 <= qq < n and foot[rr * n + qq]:
                hs = _heap_push(hh, hi, hs, S[i], i)
                break
    while hs > 0:
        i, hs = _heap_pop(hh, hi, hs)
        if done[i]:
            continue
        done[i] = True
        Hr = S[i] - B[i]
        if Hr < 0.0:
            Hr = 0.0
        r = i // n; q = i - r * n
        for k in range(8):
            rr = r + DR[k]; qq = q + DC[k]
            if rr < 0 or rr >= n or qq < 0 or qq >= n:
                continue
            j = rr * n + qq
            if done[j] or not foot[j]:
                continue
            p = S[i] - B[j] + Hr
            y = 0.5 * (-p + np.sqrt(p * p + 8.0 * c * DD[k] * dx))
            s = S[i] + y
            if s < B[j]:
                s = B[j]
            if s < S[j]:
                S[j] = s
                hs = _heap_push(hh, hi, hs, s, j)
    return S


def erosion(Q, S, B, rec, dist, fixed, n, dx, Kg, Qmin=2e3, Hmin=15.0, umax=800.0, kappa=1.5, look=6, l=1.0, uref=100.0,
            c=13.0):
    """Q, S, B: flat arrays (ice discharge, flow-line plastic ice surface, bed) on the flow network. Returns (E: bed
    erosion rate m/yr, S: ice surface m, Hi: ice thickness m), n×n, spread over each glacier's full width. The surface
    is level across a glacier (from its nearest flow line), but nowhere higher than the 2D plastic surface from the ice
    margins — so a glacier running beside the sea is thin on its seaward side; the erosion takes the plug-flow profile,
    and where glaciers overlap the bigger value wins."""
    W = width(Q)
    ice = (Q > Qmin) & ~fixed
    W2, S2, ice2, fixed2, Bn = W.reshape(n, n), S.reshape(n, n), ice.reshape(n, n), fixed.reshape(n, n), B.reshape(n, n)
    # the footprint by width class: each class gets one exact distance transform from its flow-line cells; the surface
    # comes from the nearest flow line (near a snout or calving front that is the front's low surface, not that of a
    # narrower reach upstream whose width happens to reach past it)
    edges = [3 * dx, 150, 300, 600, 1200, 2400, 1e9]
    Ss = np.where(ice2, S2, -1e9)
    dbest = np.where(ice2, 0.0, np.inf)
    spread = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        cls = ice2 & (W2 >= lo) & (W2 < hi)
        if not cls.any():
            continue
        d, (iy, ix) = ndimage.distance_transform_edt(~cls, return_indices=True)
        d = d * dx
        Wn = W2[iy, ix]
        inside = d < Wn / 2
        spread.append((iy, ix, np.where(inside, 1 - (2 * d / Wn) ** 4, 0.0)))
        nearer = inside & (d < dbest)
        Ss = np.where(nearer, S2[iy, ix], Ss)
        dbest = np.where(nearer, d, dbest)
    foot = np.isfinite(dbest) & ~fixed2                                       # no grounded ice over the sea: it calves
    Sp = plastic2d(B, foot.ravel(), n, dx, c).reshape(n, n)
    Ss = np.where(foot, np.minimum(Ss, Sp), Bn)
    Sc = np.minimum(S, Sp.ravel())
    Ec = _centre_rate(B, Sc, Q, W, fixed, Kg, Qmin, Hmin, umax, l, uref).reshape(n, n)
    E = Ec.copy()
    for iy, ix, prof in spread:
        E = np.maximum(E, Ec[iy, ix] * prof)
    Hi = np.maximum(Ss - Bn, 0.0)
    Sn = np.where(Hi > 0, Ss, Bn)
    # the adverse-slope limit on every ice cell, along its own path downstream under the spread surface — also where a
    # glacier's width reaches past its snout or calving front
    E = E * _adverse(rec, dist, B, Sn.ravel(), (Hi > 0).ravel() & ~fixed, fixed, kappa, look).reshape(n, n)
    return E, Sn, Hi
