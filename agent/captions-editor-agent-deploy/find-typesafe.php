<?php
// Read only the specifically requested TypeSafe/Jev environment entries.
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$matches = [];
foreach ([App\Models\EnvironmentVariable::class, App\Models\SharedEnvironmentVariable::class] as $model) {
    $rows = $model::where(function ($q) {
        $q->whereRaw('LOWER(key) LIKE ?', ['%typesafe%'])
          ->orWhereRaw('LOWER(key) LIKE ?', ['%jev%']);
    })->get();
    foreach ($rows as $row) {
        $matches[] = ['model' => $model, 'id' => $row->id, 'key' => $row->key,
            'resourceType' => $row->resourceable_type, 'resourceId' => $row->resourceable_id,
            'scope' => $row->type, 'isPreview' => $row->is_preview];
    }
}
echo json_encode(['matchingVariables' => $matches], JSON_PRETTY_PRINT)."\n";
