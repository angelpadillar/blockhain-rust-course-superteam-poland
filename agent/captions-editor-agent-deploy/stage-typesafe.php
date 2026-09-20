<?php
// Copies the explicitly authorized existing production TypeSafe key privately.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$rows = App\Models\EnvironmentVariable::where('key', 'TYPESAFE_API_KEY')->where('is_preview', false)->get();
$values = [];
$sources = [];
foreach ($rows as $row) {
    $value = trim((string)$row->value);
    if (strlen($value) < 16 || str_contains($value, '{{')) continue;
    $values[hash('sha256', $value)] = $value;
    $resource = $row->resourceable;
    $sources[] = ['variableId' => $row->id, 'applicationName' => $resource?->name];
}
if (count($values) !== 1) {
    echo json_encode(['status'=>'needs_source_selection', 'distinctKeys'=>count($values), 'sources'=>$sources])."\n";
    exit(2);
}
umask(0077);
$path = '/tmp/captions-typesafe-transfer.key';
file_put_contents($path, array_values($values)[0]."\n");
chmod($path, 0600);
echo json_encode(['status'=>'staged_privately', 'sources'=>$sources])."\n";
