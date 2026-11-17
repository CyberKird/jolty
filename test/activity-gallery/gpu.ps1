param([string]$pids, [int]$samples = 5)
# Sum of the 3D engine use (percent) of the given processes, averaged over $samples one-second samples.
$ids = $pids.Split(',') | ForEach-Object { 'pid_' + $_ + '_' }
$sum = 0.0
for ($i = 0; $i -lt $samples; $i++) {
  $c = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue
  $v = 0.0
  foreach ($s in $c.CounterSamples) {
    foreach ($id in $ids) { if ($s.InstanceName -like ('*' + $id + '*')) { $v += $s.CookedValue } }
  }
  $sum += $v
}
[math]::Round($sum / $samples, 2)
