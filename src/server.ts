import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import eventRoutes from './routes/event.routes';
import ticketRoutes from './routes/ticket.routes';
import organizerRoutes from './routes/organizer.routes';
import dashboardRoutes from './routes/dashboard.routes';
import paymentRoutes from './routes/payment.routes';
import userRoutes from './routes/user.routes';
import internalRoutes from './routes/internal.routes';
import {
  startReservationReclaimScheduler,
  stopReservationReclaimScheduler,
} from './services/reservationReclaim.service';
import { errorHandler, notFound } from './middleware/error.middleware';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import prisma from './config/prisma';

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));

// YeboPay webhook MUST be mounted BEFORE the global JSON body parser: its HMAC
// signature is computed over the raw request bytes, so express.json() must not
// consume/normalise the body first. The route applies express.raw() itself.
app.use('/api/payments', paymentRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
//add swagger ui
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/organizers', organizerRoutes);
app.use('/api/user', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/internal', internalRoutes);

// Health check endpoint
app.get('/health', async (_, res) => {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

// 404 handler for unmatched routes
app.use(notFound);

// Error handling middleware
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  stopReservationReclaimScheduler();
  await prisma.$disconnect();
  process.exit(0);
});

// Start server
const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('PostgreSQL Connected');
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`API Documentation available at http://localhost:${PORT}/api-docs`);
    });

    // Periodically free seats held by expired/abandoned PENDING reservations
    // across ALL ticket types (otherwise a hold is only ever reclaimed lazily
    // when another buyer happens to hit the same ticket type).
    startReservationReclaimScheduler();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
