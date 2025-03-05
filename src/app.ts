import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import cors from 'cors';
import morgan from 'morgan';
import { errorHandler } from './middleware/error.middleware';
import organizerRoutes from './routes/organizer.routes';

const app = express();

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// API Routes
app.use('/api/v2/organizers', organizerRoutes);

// Error handling
app.use(errorHandler);

export default app; 