-- Read-only security metadata; output is private and may contain role names.
select json_build_object(
  'table', 'public.furry_events',
  'table_owner', pg_get_userbyid(c.relowner),
  'rls_enabled', c.relrowsecurity,
  'rls_forced', c.relforcerowsecurity,
  'table_acl', coalesce((
    select json_agg(json_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by a.grantee,a.grantor,a.privilege_type)
    from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  ),'[]'::json),
  'column_acl', coalesce((
    select json_agg(json_build_object('column',col.attname,'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by col.attnum,a.grantee,a.grantor,a.privilege_type)
    from pg_attribute col cross join lateral aclexplode(col.attacl) a
    where col.attrelid=c.oid and col.attnum>0 and not col.attisdropped
  ),'[]'::json),
  'policies', coalesce((
    select json_agg(json_build_object('name',pol.policyname,'permissive',pol.permissive,'roles',pol.roles,
      'command',pol.cmd,'using',pol.qual,'with_check',pol.with_check) order by pol.policyname)
    from pg_policies pol where pol.schemaname='public' and pol.tablename='furry_events'
  ),'[]'::json),
  'sync_rpc', 'public.sync_furry_events(jsonb,timestamptz,boolean)',
  'rpc_owner', pg_get_userbyid(p.proowner),
  'rpc_security_definer', p.prosecdef,
  'rpc_acl', coalesce((
    select json_agg(json_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by a.grantee,a.grantor,a.privilege_type)
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  ),'[]'::json),
  'role_memberships', coalesce((
    select json_agg(json_build_object('role',parent.rolname,'member',member.rolname,
      'admin',m.admin_option,'inherit',m.inherit_option,'set_role',m.set_option)
      order by parent.rolname,member.rolname)
    from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member
  ),'[]'::json),
  'roles', coalesce((
    select json_agg(json_build_object('name',r.rolname,'login',r.rolcanlogin,'inherit',r.rolinherit,
      'bypass_rls',r.rolbypassrls,'superuser',r.rolsuper) order by r.rolname)
    from pg_roles r
  ),'[]'::json)
) from pg_class c cross join pg_proc p
where c.oid='public.furry_events'::regclass
  and p.oid='public.sync_furry_events(jsonb,timestamptz,boolean)'::regprocedure;
