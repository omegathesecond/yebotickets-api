# Yebo Tickets API v2

A modern event ticketing platform API built with Node.js, Express, TypeScript, and MongoDB.

## Features

- 🔐 **Authentication & Authorization**
  - WhatsApp OTP verification
  - JWT-based authentication
  - Role-based access control (User, Organizer, Admin)

- 👥 **User Management**
  - User registration and verification
  - Profile management
  - Role-based permissions

- 🎫 **Event Management**
  - Create and manage events
  - Multiple ticket types
  - Event categories and tags
  - Event search and filtering

- 🏢 **Organizer Features**
  - Organizer registration and verification
  - Event creation and management
  - Dashboard with analytics
  - Profile customization

- 👑 **Admin Features**
  - User and organizer management
  - System-wide analytics
  - Content moderation
  - Platform settings

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose
- **Authentication**: JWT & WhatsApp OTP
- **Documentation**: Swagger/OpenAPI
- **Validation**: Express Validator
- **Logging**: Morgan
- **Testing**: Jest (planned)

## Prerequisites

- Node.js (v14 or higher)
- MongoDB
- WhatsApp Business API credentials
- TypeScript knowledge

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/yebo-tickets-api-v2.git
   cd yebo-tickets-api-v2
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a .env file:
   ```env
   NODE_ENV=development
   PORT=5000
   MONGODB_URI=mongodb://localhost:27017/yebo-tickets
   JWT_SECRET=your_jwt_secret
   JWT_EXPIRES_IN=24h
   WHATSAPP_API_KEY=your_whatsapp_api_key
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Start the server:
   ```bash
   npm start
   ```

## API Documentation

The API documentation is available through Swagger UI at `/api-docs` when the server is running. The documentation is automatically generated from the code annotations and provides:

- Interactive API exploration
- Request/response examples
- Authentication requirements
- Schema definitions
- Error responses

### Authentication
All protected endpoints require a JWT token in the Authorization header:
```http
Authorization: Bearer your_jwt_token_here
```

### Response Format
All API responses follow a standard format:
```json
{
  "success": true,
  "message": "Optional message",
  "data": {
    // Response data
  }
}
```

### Error Handling
Errors follow a consistent format:
```json
{
  "success": false,
  "message": "Error description"
}
```

### Common HTTP Status Codes
- `200`: Success
- `201`: Created
- `400`: Bad Request
- `401`: Unauthorized
- `403`: Forbidden
- `404`: Not Found
- `500`: Internal Server Error

### Key Endpoints

#### Authentication
- `POST /api/v2/auth/request-otp`: Request WhatsApp OTP
- `POST /api/v2/auth/verify-otp`: Verify OTP and get token

#### Organizers
- `POST /api/v2/organizers/signup`: Register as organizer
- `POST /api/v2/organizers/login`: Login as organizer
- `GET /api/v2/organizers/profile`: Get organizer profile
- `PUT /api/v2/organizers/profile`: Update organizer profile
- `GET /api/v2/organizers/dashboard`: Get organizer dashboard
- `GET /api/v2/organizers/events`: Get organizer events
- `POST /api/v2/organizers/events`: Create new event

#### Admin Routes
- `GET /api/v2/organizers/all`: Get all organizers
- `PUT /api/v2/organizers/:id/status`: Update organizer status
- `DELETE /api/v2/organizers/:id`: Delete organizer

## Development

1. Start in development mode:
   ```bash
   npm run dev
   ```

2. Run tests:
   ```bash
   npm test
   ```

3. Check linting:
   ```bash
   npm run lint
   ```

4. Fix linting issues:
   ```bash
   npm run lint:fix
   ```

## Project Structure

```
src/
├── config/         # Configuration files
├── controllers/    # Request handlers
├── interfaces/     # TypeScript interfaces
├── middleware/     # Custom middleware
├── models/         # Mongoose models
├── routes/         # Route definitions
├── services/       # Business logic
├── types/          # TypeScript types
├── utils/          # Utility functions
├── validators/     # Request validators
└── app.ts         # Express app setup
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, email support@yebotickets.com or join our Slack channel.
