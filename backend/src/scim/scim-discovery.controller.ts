/**
 * SCIM 2.0 discovery endpoints (RFC 7644 § 4):
 *   GET /scim/v2/ServiceProviderConfig
 *   GET /scim/v2/ResourceTypes
 *   GET /scim/v2/Schemas
 *
 * Public — IdPs hit these without authentication.
 */
import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA } from './scim-mapper';

@ApiExcludeController()
@Controller('scim/v2')
export class ScimDiscoveryController {
  @Get('ServiceProviderConfig')
  spc() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://docs.example.com/scim',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Per-org bearer token issued by the platform admin.',
          specUri: 'https://datatracker.ietf.org/doc/html/rfc6750',
          primary: true,
        },
      ],
      meta: { resourceType: 'ServiceProviderConfig' },
    };
  }

  @Get('ResourceTypes')
  resourceTypes() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          description: 'User Account',
          schema: SCIM_USER_SCHEMA,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          description: 'Role-derived group (read-only — admin/reviewer/employee/consultant)',
          schema: SCIM_GROUP_SCHEMA,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
        },
      ],
    };
  }

  @Get('Schemas')
  schemas() {
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 2,
      Resources: [
        {
          id: SCIM_USER_SCHEMA,
          name: 'User',
          description: 'User Account',
          attributes: USER_ATTRS,
          meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_USER_SCHEMA}` },
        },
        {
          id: SCIM_GROUP_SCHEMA,
          name: 'Group',
          description: 'Group',
          attributes: GROUP_ATTRS,
          meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_GROUP_SCHEMA}` },
        },
      ],
    };
  }
}

const USER_ATTRS = [
  attr('userName', 'string', { required: true, uniqueness: 'server' }),
  attr('name', 'complex', {
    subAttributes: [
      attr('givenName', 'string'),
      attr('familyName', 'string'),
      attr('formatted', 'string'),
    ],
  }),
  attr('emails', 'complex', {
    multiValued: true,
    subAttributes: [
      attr('value', 'string', { required: true }),
      attr('type', 'string'),
      attr('primary', 'boolean'),
    ],
  }),
  attr('active', 'boolean'),
  attr('roles', 'complex', {
    multiValued: true,
    subAttributes: [
      attr('value', 'string'),
      attr('primary', 'boolean'),
    ],
  }),
];

const GROUP_ATTRS = [
  attr('displayName', 'string', { required: true }),
  attr('members', 'complex', {
    multiValued: true,
    subAttributes: [
      attr('value', 'string'),
      attr('display', 'string'),
    ],
  }),
];

function attr(
  name: string,
  type: 'string' | 'boolean' | 'integer' | 'complex',
  opts: {
    required?: boolean;
    multiValued?: boolean;
    uniqueness?: 'none' | 'server' | 'global';
    subAttributes?: ReturnType<typeof attr>[];
  } = {},
): Record<string, unknown> {
  return {
    name,
    type,
    multiValued: opts.multiValued ?? false,
    required: opts.required ?? false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: opts.uniqueness ?? 'none',
    ...(opts.subAttributes ? { subAttributes: opts.subAttributes } : {}),
  };
}
