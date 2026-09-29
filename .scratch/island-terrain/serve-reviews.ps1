# Brings every review build back up on its port (detached, survives the session).
# Run from anywhere:  powershell -File C:\Users\garre\Documents\code\uplift\.scratch\island-terrain\serve-reviews.ps1
$root = "C:\Users\garre\Documents\code\uplift"
$wt   = "$root\.claude\worktrees"
$servers = @(
  @{ port = 8765; dir = $root;                                              what = "main checkout (ticket 17 via ?island=rock3)" },
  @{ port = 8776; dir = "$wt\agent-adc9bc8b3d9d35267";                     what = "28 climate (?island=c28clim / c28old)" },
  @{ port = 8783; dir = "$wt\agent-aa93365d0022c8466";                     what = "31 soil (?island=soil1 / soil0)" },
  @{ port = 8771; dir = "$wt\agent-aa9a1c41975ab1fca";                     what = "19 rivers" },
  @{ port = 8774; dir = "$wt\agent-a87d73b3b15dce631";                     what = "23 clouds (&wx=fair|building|showery|overcast)" },
  @{ port = 8775; dir = "$wt\agent-a1f80725b304da96e";                     what = "27 pause Esc (esc-fixed / esc-old builds)" },
  @{ port = 8766; dir = "C:\Users\garre\Documents\code\windborne-physics"; what = "glider stability (separate repo, branch plane-physics)" }
)
foreach ($s in $servers) {
  $busy = netstat -ano | Select-String "LISTENING" | Select-String (":" + $s.port + " ")
  if ($busy) { Write-Host ("{0} already up  - {1}" -f $s.port, $s.what); continue }
  Start-Process -FilePath py -ArgumentList @('-m','http.server',"$($s.port)",'--bind','127.0.0.1','--directory',$s.dir) -WindowStyle Hidden
  Write-Host ("{0} started     - {1}" -f $s.port, $s.what)
}
