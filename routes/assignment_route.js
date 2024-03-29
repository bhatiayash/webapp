const express = require('express');
const router = express.Router();
const basicAuth = require('basic-auth');
const db = require('../models/index');
const bcrypt = require('bcrypt');
const logger = require('../logger.js');
const StatsD = require('node-statsd');
const client = new StatsD();
const AWS = require('aws-sdk');


AWS.config.update({
  region: 'us-east-1', // Replace with your AWS region
  // accessKeyId: 'your-access-key-id', // Replace with your AWS access key ID
  // secretAccessKey: 'your-secret-access-key', // Replace with your AWS secret access key
});
const sns = new AWS.SNS();

// // Displaying 405 for patch
// router.use('/', (req, res, next) => {
//   if (req.method == 'PATCH') {
//     res.status(405).json();
//   } else {
//     next();
//   }
// });


const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    logger.warn('Unauthorized Access');
    return res.status(401).send('Unauthorized');
  }

  // Extract and decode the Base64 credentials
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [email, password] = credentials.split(':');

  try {
    // Check the email against your database
    const account = await db.Account.findOne({ where: { email } });

    if (!account) {
      logger.warn('Unauthorized Access');
      return res.status(401).send('Unauthorized');
    }

    // Compare the provided password with the hashed password stored in the database
    const passwordMatch = await bcrypt.compare(password, account.password);

    if (!passwordMatch) {
      logger.warn('Unauthorized Access');
      return res.status(401).send('Unauthorized');
    }

    // If authentication is successful, store the authenticated user data (e.g., user ID) in req.user
    req.user = account;

    next();
  } catch (error) {
    console.error(error);
    logger.error('Service Unavailable');
    res.status(503).json({ error: 'Service Unavailable' });
  }
};


// route for getting the list of assignments
router.get('/', authenticate, async (req, res) => {
  try {
    // Fetch the list of assignments from your database
    const assignments = await db.Assignment.findAll();
    client.increment("AllAssignments", 1);
    logger.info('List of assignments');
   // Return the list of assignments as JSON
    res.status(200).json(assignments);
  } catch (error) {
    console.error(error);
    logger.error('Database is not connected');
    res.status(503).json({ error: 'Service Unavailable' });
  }
});


// Route to create a new assignment
router.post('/', authenticate, async (req, res) => {
    try {
      // Extract assignment data from the request body
      const { name, points, num_of_attempts, deadline } = req.body;
  
      // Validate request body
      if (!name || !points || !num_of_attempts || !deadline) {
        logger.warn('Bad Request: Incomplete Body');
        return res.status(400).json({ error: 'Bad Request' });
      }

      // Validate the points field (between 1 and 10)
    if (isNaN(points) || points < 1 || points > 10) {
      logger.warn('Points must be between 1 and 10');
      return res.status(400).json({ error: 'Points must be between 1 and 10' });
    }

    // Check if num_of_attempts is less than 1
    if (isNaN(num_of_attempts) || num_of_attempts < 1) {
      logger.warn('num_of_attempts must be at least 1');
      return res.status(400).json({ error: 'num_of_attempts must be at least 1' });
    }

    // Validate the 'deadline' as a date
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate)) {
      logger.warn('Invalid date format for deadline');
      return res.status(400).json({ error: 'Invalid date format for deadline' });
    }
  
      // Create the assignment in the database
      const assignment = await db.Assignment.create({
        name,
        points,
        num_of_attempts,
        deadline,
      });

      // const accountId = req.user.id;
      // console.log("account----",accountId);
      // //const assignmentId = req.params.id;
      // //create a record in accountassignment
      // const accountassignment= await db.AccountAssignment.create({
      //   accountId,
      //   assignmentId,
      // });
      //console.log("assignment-----:",assignment.id);
      const accountId = req.user.id;
      const assignmentId = assignment.id
      await db.AccountAssignment.create({
        accountId,
        assignmentId,
      });
  
      // Return a success response with the created assignment
      client.increment("AssignmentPost", 1);
      logger.info('Assignment Created');
      res.status(201).json(assignment);
      //console.log("assignment-----:",assignment.id);
    } catch (error) {
      console.error(error);
      logger.error('Service Unavailable');
      res.status(503).json({ error: 'Service Unavailable' });
    }
  });



  
  // Route to get assignment details by ID
router.get('/:id', authenticate, async (req, res) => {
    try {
      const assignmentId = req.params.id;
  
      // Find the assignment by ID in the database
      const assignment = await db.Assignment.findOne({ where: { id: assignmentId } });
  
      if (!assignment) {
        logger.warn('Assignment not found');
        return res.status(404).json({ error: 'Assignment not found' });
      }
  
      // Return the assignment details in the response
      client.increment("AssignmentsId", 1);
      logger.info('Requested assignment by ID');
      res.status(200).json(assignment);
    } catch (error) {
      console.error(error);
      logger.error('Service Unavailable');
      res.status(503).json({ error: 'Service Unavailable' });
    }
  });


// Route to delete an assignment by ID
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const accountId = req.user.id; // Get the ID of the authenticated user

    const assignment1 = await db.Assignment.findOne({ where: { id: assignmentId } });
  
      if (!assignment1) {
        logger.warn('Assignment not found');
        return res.status(404).json({ error: 'Assignment not found' });
      }

    // Check if the assignment exists and is associated with the authenticated user
    const assignment = await db.Assignment.findOne({
      where: { id: assignmentId },
      include: [
        {
          model: db.Account,
          as: 'users', // This assumes that you have defined 'as: users' in your Assignment model
          where: { id: accountId }, // Check if the assignment is associated with the authenticated user
        },
      ],
    });

    if (!assignment) {
      logger.warn('Forbidden access for this account');
      return res.status(403).json({ error: 'forbidden' });
    }

    // Check if the submission is present so dont allow to delete
    const userAttempts = await db.submission.count({
      where: { assignment_id: assignmentId },
      // where: { assignment_id: assignmentId, submitted_by: accountId },
    });

    if (userAttempts > 0) {
      logger.warn('Cannot delete this assignment as there are submissions against it');
      return res.status(400).json({ error: 'Cannot delete this assignment as there are submissions against it' });
    }

    // Delete the assignment
    await assignment.destroy();

    // Return a success response with no content (204 No Content)
    client.increment("AssignmentDelete", 1);
    logger.info('Assignment Deleted');
    res.status(204).send();
  } catch (error) {
    console.error(error);
    logger.error('Service Unavailable');
    res.status(503).json({ error: 'Service Unavailable' });
  }
});

// Route to update an assignment by ID
router.put('/:id', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const accountId = req.user.id; // Get the ID of the authenticated user

    const assignment1 = await db.Assignment.findOne({ where: { id: assignmentId } });
  
      if (!assignment1) {
        logger.warn('Assignment not found');
        return res.status(404).json({ error: 'Assignment not found' });
      }

    // Find the assignment by ID and ensure it's associated with the authenticated user
    const assignment = await db.Assignment.findOne({
      where: { id: assignmentId }, // Check both assignment ID and accountId
      include: [
        {
          model: db.Account,
          as: 'users', // This assumes that you have defined 'as: users' in your Assignment model
          where: { id: accountId }, // Check if the assignment is associated with the authenticated user
        },
      ],
    });

    if (!assignment) {
      logger.warn('Forbidden access for this account');
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Extract assignment data from the request body
    const { name, points, num_of_attempts, deadline } = req.body;

    // Validate request body
    if (!name || !points || !num_of_attempts || !deadline) {
      logger.warn('Bad Request: Incomplete Body');
      return res.status(400).json({ error: 'Bad Request' });
    }

    // Validate the points field (between 1 and 10)
    if (isNaN(points) || points < 1 || points > 10) {
      logger.warn('Points must be between 1 and 10');
      return res.status(400).json({ error: 'Points must be between 1 and 10' });
    }

    // Check if num_of_attempts is less than 1
    if (isNaN(num_of_attempts) || num_of_attempts < 1) {
      logger.warn('num_of_attempts must be at least 1');
      return res.status(400).json({ error: 'num_of_attempts must be at least 1' });
    }

    // Validate the 'deadline' as a date
    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate)) {
      logger.warn('Invalid date format for deadline');
      return res.status(400).json({ error: 'Invalid date format for deadline' });
    }
    

    // Update the assignment with the new data
    await assignment.update({
      name,
      points,
      num_of_attempts,
      deadline,
    });

    // Return a success response with no content (204 No Content)
    client.increment("AssignmentUpdate", 1);
    logger.info('Assignment Updated');
    res.status(204).send();
  } catch (error) {
    console.error(error);
    logger.error('Service Unavailable');
    res.status(503).json({ error: 'Service Unavailable' });
  }
});

// Route to submit an assignment
router.post('/:id/submission', authenticate, async (req, res) => {
  try {
    const assignmentId = req.params.id;
    const accountId = req.user.id; // Get the ID of the authenticated user

    // Check if the assignment exists and is associated with the authenticated user
    const assignment = await db.Assignment.findOne({
      where: { id: assignmentId },
      // include: [
      //   {
      //     model: db.Account,
      //     as: 'users', // This assumes that you have defined 'as: users' in your Assignment model
      //     where: { id: accountId }, // Check if the assignment is associated with the authenticated user
      //   },
      // ],
    });

    // if (!assignment) {
    //   logger.warn('Forbidden access for this account or Assignment not found');
    //   return res.status(403).json({ error: 'Forbidden' });
    // }

    if (!assignment) {
      logger.warn('Assignment not found.');
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    // Check if the deadline has passed
    const currentDate = new Date();
    if (currentDate > assignment.deadline) {
      logger.warn('Submission deadline has passed');
      return res.status(400).json({ error: 'Submission deadline has passed' });
    }

    // Check if the user has exceeded the number of attempts
    const userAttempts = await db.submission.count({
      where: { assignment_id: assignmentId, account_id: accountId },
      // where: { assignment_id: assignmentId, submitted_by: accountId },
    });

    if (userAttempts >= assignment.num_of_attempts) {
      logger.warn('Exceeded number of submission attempts');
      return res.status(400).json({ error: 'Exceeded number of submission attempts' });
    }

    // Extract submission data from the request body
    const { submission_url } = req.body;

    // Validate request body
    if (!submission_url) {
      logger.warn('Bad Request: Incomplete Body');
      return res.status(400).json({ error: 'Bad Request' });
    }

    // Post URL to SNS topic along with user info
    const snsMessage = {
      email: req.user.email, // Assuming your user model has an email field
      submission_url,
      assignmentId,
      accountId,
    };

    const snsParams = {
      Message: JSON.stringify(snsMessage),
      //TopicArn: 'arn:aws:sns:us-east-1:014622572805:mySNSTopic-c28d63c', // Replace with your SNS topic ARN
      TopicArn: process.env.SNS_TOPIC_ARN,
    };

    sns.publish(snsParams, (err, data) => {
      if (err) {
        console.error('Error publishing to SNS:', err);
        logger.error('Error publishing to SNS',err);
        return res.status(500).json({ error: 'Error publishing to SNS' });
      }

      // Create the submission in the database if SNS is successful
      db.submission.create({
        assignment_id: assignmentId,
        submission_url,
        account_id: accountId,
      });

      // Return a success response with the created submission
      client.increment('SubmissionPost', 1);
      logger.info('Submission Created');
      res.status(201).json({ message: 'Submission created successfully' });
    });

    // // Create the submission in the database
    // const submission = await db.submission.create({
    //   assignment_id: assignmentId,
    //   submission_url,
    // });

    // // Return a success response with the created submission
    // client.increment("SubmissionPost", 1);
    // logger.info('Submission Created');
    // res.status(201).json(submission);
  } catch (error) {
    console.error(error);
    logger.error('Service Unavailable',error);
    res.status(503).json({ error: 'Service Unavailable' });
  }
});


module.exports = router;

