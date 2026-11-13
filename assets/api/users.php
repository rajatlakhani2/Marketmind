<?php
// MarketMind AI — admin-only user management.
//
// GET  ?action=list
// POST ?action=create          { username, displayName, password, role }
// POST ?action=update          { id, displayName?, role?, isActive? }
// POST ?action=reset_password  { id, password }   (user must choose a new one at next sign-in)
// POST ?action=delete          { id }
// POST ?action=approve         { id }   (a sign-up request: switches the account on)
// POST ?action=reject          { id }   (a sign-up request: keeps it off and tells them at sign-in)
//
// POST requests must send the header  X-Requested-With: MarketMind

declare(strict_types=1);
require __DIR__ . '/lib/bootstrap.php';

$action = (string) ($_GET['action'] ?? '');

try {
    $admin = mm_require_admin();
    $pdo = mm_db();

    if ($action === 'list') {
        $rows = $pdo->query("SELECT * FROM users ORDER BY approval_status = 'pending' DESC, role = 'admin' DESC, username")->fetchAll();
        mm_json(200, ['users' => array_map('mm_public_user', $rows)]);
    }

    if ($action === 'create') {
        $body = mm_require_post();
        $username = mm_check_username(mm_str($body, 'username', 50));
        $password = (string) ($body['password'] ?? '');
        mm_check_password($password);
        $role = mm_role($body);
        $st = $pdo->prepare('SELECT COUNT(*) FROM users WHERE username = ?');
        $st->execute([$username]);
        if ((int) $st->fetchColumn() > 0) mm_json(409, ['error' => "Username \"$username\" is already taken"]);
        // The admin chooses whether the new user must pick their own password at first sign-in
        $must = !empty($body['mustChange']) ? 1 : 0;
        $pdo->prepare('INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, created_at, created_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
            ->execute([$username, mm_str($body, 'displayName', 100), password_hash($password, PASSWORD_DEFAULT), $role, $must, mm_now(), $admin['id']]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_find((int) $pdo->lastInsertId()))]);
    }

    if ($action === 'update') {
        $body = mm_require_post();
        $u = mm_find((int) ($body['id'] ?? 0));
        $self = (int) $u['id'] === (int) $admin['id'];
        $role = array_key_exists('role', $body) ? mm_role($body) : $u['role'];
        $active = array_key_exists('isActive', $body) ? (!empty($body['isActive']) ? 1 : 0) : (int) $u['is_active'];
        if ($self && ($role !== 'admin' || !$active)) mm_json(400, ['error' => "You can't remove your own admin access or switch off your own account"]);
        if ($u['role'] === 'admin' && ($role !== 'admin' || !$active)) mm_keep_one_admin((int) $u['id']);
        $name = array_key_exists('displayName', $body) ? mm_str($body, 'displayName', 100) : $u['display_name'];
        $approval = $active ? 'approved' : ($u['approval_status'] ?? 'approved');
        $pdo->prepare('UPDATE users SET display_name = ?, role = ?, is_active = ?, approval_status = ? WHERE id = ?')->execute([$name, $role, $active, $approval, $u['id']]);
        if (!$active) $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$u['id']]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_find((int) $u['id']))]);
    }

    if ($action === 'approve' || $action === 'reject') {
        $body = mm_require_post();
        $u = mm_find((int) ($body['id'] ?? 0));
        if (($u['approval_status'] ?? 'approved') === 'approved') mm_json(400, ['error' => 'This account is not waiting for approval']);
        $ok = $action === 'approve';
        $pdo->prepare("UPDATE users SET approval_status = ?, is_active = ?, role = 'user' WHERE id = ?")->execute([$ok ? 'approved' : 'rejected', $ok ? 1 : 0, $u['id']]);
        mm_json(200, ['ok' => true, 'user' => mm_public_user(mm_find((int) $u['id']))]);
    }

    if ($action === 'reset_password') {
        $body = mm_require_post();
        $u = mm_find((int) ($body['id'] ?? 0));
        if ((int) $u['id'] === (int) $admin['id']) mm_json(400, ['error' => 'Use "Change password" for your own account']);
        $password = (string) ($body['password'] ?? '');
        mm_check_password($password);
        $must = !empty($body['mustChange']) ? 1 : 0;
        $pdo->prepare('UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $must, mm_now(), $u['id']]);
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$u['id']]);
        mm_json(200, ['ok' => true]);
    }

    if ($action === 'delete') {
        $body = mm_require_post();
        $u = mm_find((int) ($body['id'] ?? 0));
        if ((int) $u['id'] === (int) $admin['id']) mm_json(400, ["error" => "You can't delete your own account"]);
        if ($u['role'] === 'admin') mm_keep_one_admin((int) $u['id']);
        // Child rows are removed explicitly as well, in case foreign keys are off
        foreach (['sessions', 'user_settings', 'knowledge_items', 'broker_accounts'] as $t) $pdo->prepare("DELETE FROM $t WHERE user_id = ?")->execute([$u['id']]);
        $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$u['id']]);
        mm_json(200, ['ok' => true]);
    }

    mm_json(400, ['error' => 'Unknown action']);
} catch (Throwable $e) {
    error_log('MarketMind users error: ' . $e->getMessage());
    mm_json(500, ['error' => 'Server error. Check the PHP error log on the host.']);
}

function mm_find(int $id): array {
    $st = mm_db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $u = $st->fetch();
    if (!$u) mm_json(404, ['error' => 'User not found']);
    return $u;
}

function mm_role(array $body): string {
    $role = (string) ($body['role'] ?? 'user');
    if (!in_array($role, MM_ROLES, true)) mm_json(400, ['error' => 'Role must be admin or user']);
    return $role;
}

function mm_keep_one_admin(int $exceptId): void {
    $st = mm_db()->prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?");
    $st->execute([$exceptId]);
    if ((int) $st->fetchColumn() === 0) mm_json(400, ['error' => 'There must always be at least one active admin']);
}
