import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Yebo Tickets API',
      version: '2.0.0',
      description: 'API documentation for Yebo Tickets event ticketing platform',
      contact: {
        name: 'API Support',
        email: 'support@yebotickets.com'
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT'
      }
    },
    servers: [
      {
        url: '/api/v2',
        description: 'API v2'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false
            },
            message: {
              type: 'string',
              example: 'Error message description'
            }
          }
        },
        // Event related schemas
        EventLocation: {
          type: 'object',
          properties: {
            address: {
              type: 'string',
              example: '123 Main St'
            },
            city: {
              type: 'string',
              example: 'Cape Town'
            },
            country: {
              type: 'string',
              example: 'South Africa'
            },
            coordinates: {
              type: 'object',
              properties: {
                lat: {
                  type: 'number',
                  example: -33.925
                },
                lng: {
                  type: 'number',
                  example: 18.423
                }
              }
            }
          },
          required: ['address', 'city', 'country']
        },
        Event: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            title: {
              type: 'string',
              example: 'Cape Town Jazz Festival'
            },
            description: {
              type: 'string',
              example: 'The biggest jazz festival in Africa, featuring local and international artists.'
            },
            location: {
              $ref: '#/components/schemas/EventLocation'
            },
            startDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-15T18:00:00.000Z'
            },
            endDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-17T22:00:00.000Z'
            },
            organizer: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            isPublished: {
              type: 'boolean',
              example: true
            },
            coverImage: {
              type: 'string',
              example: 'https://example.com/images/jazz-festival.jpg'
            },
            category: {
              type: 'string',
              example: 'Music'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-01T12:00:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-10T15:30:00.000Z'
            }
          }
        },
        EventRequest: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              example: 'Cape Town Jazz Festival'
            },
            description: {
              type: 'string',
              example: 'The biggest jazz festival in Africa, featuring local and international artists.'
            },
            location: {
              $ref: '#/components/schemas/EventLocation'
            },
            startDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-15T18:00:00.000Z'
            },
            endDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-17T22:00:00.000Z'
            },
            isPublished: {
              type: 'boolean',
              example: true
            },
            coverImage: {
              type: 'string',
              example: 'https://example.com/images/jazz-festival.jpg'
            },
            category: {
              type: 'string',
              example: 'Music'
            }
          },
          required: ['title', 'description', 'location', 'startDate', 'endDate', 'category']
        },
        EventResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              $ref: '#/components/schemas/Event'
            }
          }
        },
        EventsResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            count: {
              type: 'number',
              example: 10
            },
            pagination: {
              type: 'object',
              properties: {
                page: {
                  type: 'number',
                  example: 1
                },
                pages: {
                  type: 'number',
                  example: 2
                },
                limit: {
                  type: 'number',
                  example: 10
                },
                total: {
                  type: 'number',
                  example: 15
                },
                next: {
                  type: 'number',
                  example: 2,
                  nullable: true
                },
                prev: {
                  type: 'number',
                  example: null,
                  nullable: true
                }
              }
            },
            data: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Event'
              }
            }
          }
        },
        // Ticket related schemas
        TicketType: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            name: {
              type: 'string',
              example: 'VIP Pass'
            },
            description: {
              type: 'string',
              example: 'Access to all areas including backstage and VIP lounge'
            },
            price: {
              type: 'number',
              example: 1500
            },
            quantity: {
              type: 'integer',
              example: 100
            },
            eventId: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            type: {
              type: 'string',
              enum: ['standard', 'vip', 'early_bird', 'group'],
              example: 'vip'
            },
            saleStartDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-05-01T00:00:00.000Z'
            },
            saleEndDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-10T23:59:59.000Z'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-01T12:00:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-01T12:00:00.000Z'
            }
          }
        },
        TicketTypeRequest: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              example: 'VIP Pass'
            },
            description: {
              type: 'string',
              example: 'Access to all areas including backstage and VIP lounge'
            },
            price: {
              type: 'number',
              example: 1500
            },
            quantity: {
              type: 'integer',
              example: 100
            },
            type: {
              type: 'string',
              enum: ['standard', 'vip', 'early_bird', 'group'],
              example: 'vip'
            },
            saleStartDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-05-01T00:00:00.000Z'
            },
            saleEndDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-06-10T23:59:59.000Z'
            }
          },
          required: ['name', 'price', 'quantity', 'saleStartDate', 'saleEndDate']
        },
        Ticket: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            ticketTypeId: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            eventId: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3'
            },
            userId: {
              type: 'string',
              example: '60a12f9d1c9d440000a1b2c3',
              nullable: true
            },
            status: {
              type: 'string',
              enum: ['available', 'sold', 'reserved', 'cancelled'],
              example: 'sold'
            },
            purchaseDate: {
              type: 'string',
              format: 'date-time',
              example: '2023-05-15T10:30:00.000Z',
              nullable: true
            },
            uniqueCode: {
              type: 'string',
              example: 'ABC12345XZ'
            },
            isCheckedIn: {
              type: 'boolean',
              example: false
            },
            checkedInAt: {
              type: 'string',
              format: 'date-time',
              example: null,
              nullable: true
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-01T12:00:00.000Z'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              example: '2023-03-01T12:00:00.000Z'
            }
          }
        },
        TicketTypeResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              $ref: '#/components/schemas/TicketType'
            }
          }
        },
        TicketTypesResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            count: {
              type: 'number',
              example: 3
            },
            data: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/TicketType'
              }
            }
          }
        },
        TicketResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              $ref: '#/components/schemas/Ticket'
            }
          }
        },
        TicketsResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            count: {
              type: 'number',
              example: 5
            },
            data: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/Ticket'
              }
            }
          }
        },
        GenerateTicketsRequest: {
          type: 'object',
          properties: {
            quantity: {
              type: 'integer',
              example: 50
            }
          },
          required: ['quantity']
        },
        PurchaseTicketResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              $ref: '#/components/schemas/Ticket'
            },
            message: {
              type: 'string',
              example: 'Ticket purchased successfully'
            }
          }
        },
        VerifyTicketRequest: {
          type: 'object',
          properties: {
            ticketCode: {
              type: 'string',
              example: 'ABC12345XZ'
            }
          },
          required: ['ticketCode']
        },
        VerifyTicketResponse: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: true
            },
            data: {
              type: 'object',
              properties: {
                ticket: {
                  $ref: '#/components/schemas/Ticket'
                },
                event: {
                  $ref: '#/components/schemas/Event'
                },
                ticketType: {
                  $ref: '#/components/schemas/TicketType'
                },
                user: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      example: 'John Doe'
                    },
                    email: {
                      type: 'string',
                      example: 'john@example.com'
                    },
                    phone: {
                      type: 'string',
                      example: '+27123456789'
                    }
                  }
                }
              }
            },
            message: {
              type: 'string',
              example: 'Ticket verified and checked in successfully'
            }
          }
        }
      }
    },
    security: [{
      bearerAuth: []
    }],
    tags: [
      {
        name: 'Auth',
        description: 'Authentication endpoints'
      },
      {
        name: 'Organizers',
        description: 'Organizer management endpoints'
      },
      {
        name: 'Events',
        description: 'Event management endpoints'
      },
      {
        name: 'Tickets',
        description: 'Ticket management endpoints'
      }
    ]
  },
  apis: [
    './src/routes/*.ts',
    './src/models/*.ts',
    './src/interfaces/*.ts'
  ],
  // Enable swagger-ui custom CSS
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Yebo Tickets API Documentation'
};

export const swaggerSpec = swaggerJsdoc(options); 